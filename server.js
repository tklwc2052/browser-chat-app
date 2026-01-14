require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const fs = require('fs'); 
// NEW DEPENDENCIES
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

const app = express();
const server = http.createServer(app);

// --- 1. AUTOMATIC UPDATE MESSAGE ---
let SERVER_BUILD_DESC = "System Update"; 
const SERVER_BUILD_ID = Date.now(); 

try {
    if (fs.existsSync('build_desc.txt')) {
        SERVER_BUILD_DESC = fs.readFileSync('build_desc.txt', 'utf8').trim();
        console.log(`✅ Loaded Update Message: "${SERVER_BUILD_DESC}"`);
    }
} catch (e) {
    console.log("⚠️ build_desc.txt not found. Using default.");
}

// --- CLOUDINARY CONFIG ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer config (Memory storage to handle buffer)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const io = socketIo(server, { maxHttpBufferSize: 1e7 }); // 10MB payload limit

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- SCHEMAS ---
const messageSchema = new mongoose.Schema({
    sender: String,
    displayName: String, // Store display name in history
    avatar: String,      // Store avatar URL in history
    text: String,
    image: String,       // URL to Cloudinary image
    timestamp: { type: Date, default: Date.now },
    isSystem: { type: Boolean, default: false },
    replyTo: { type: Object, default: null } // Store the parent message object
});
const Message = mongoose.model('Message', messageSchema);

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    displayName: String,
    description: String,
    pronouns: String,
    avatar: String,
    banner: String,
    customBackground: String,
    lastSeen: Date,
    socketId: String // Track current socket
});
const User = mongoose.model('User', userSchema);

// Ban Schema
const banSchema = new mongoose.Schema({
    ip: String,
    reason: String,
    bannedAt: { type: Date, default: Date.now }
});
const Ban = mongoose.model('Ban', banSchema);

// --- STATE ---
const users = {}; 
const vcUsers = {}; // Track users in VC: { socketId: username }
const mutedUsers = new Set();
const disconnectTimeouts = {}; // For grace period

const bannedIPs = new Set(); // Cache for fast lookup

// Load bans on startup
Ban.find().then(bans => bans.forEach(b => bannedIPs.add(b.ip)));

// --- MIDDLEWARE ---
app.set('trust proxy', 1); // Trust first proxy (Render/Heroku/etc)
app.use(express.static(path.join(__dirname, 'public')));

// --- ROUTES ---

// Upload Route
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: 'chat_uploads' },
        (error, result) => {
            if (error) return res.status(500).json({ error: error.message });
            res.json({ url: result.secure_url });
        }
    );
    stream.Readable.from(req.file.buffer).pipe(uploadStream);
});

// --- SOCKET.IO ---
io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    
    // Check Ban
    if (bannedIPs.has(clientIp)) {
        socket.emit('banned', 'You are banned from this server.');
        socket.disconnect();
        return;
    }

    // Send Build Info immediately
    socket.emit('server-build-info', { id: SERVER_BUILD_ID, desc: SERVER_BUILD_DESC });

    console.log('New user connected:', socket.id);

    // Send history
    const history = await Message.find().sort({ timestamp: 1 }).limit(50);
    socket.emit('load-history', history);

    // Send current user list
    io.emit('update-user-list', Object.values(users));
    
    // Send current VC list
    socket.emit('update-vc-list', Object.values(vcUsers));

    // Handle User Join
    socket.on('join', async (username) => {
        // If Grace Period Active, cancel it
        if (disconnectTimeouts[username]) {
            clearTimeout(disconnectTimeouts[username]);
            delete disconnectTimeouts[username];
        }

        // Fetch or Create User Profile
        let userProfile = await User.findOne({ username });
        if (!userProfile) {
            userProfile = new User({ 
                username, 
                displayName: username, 
                avatar: 'placeholder-avatar.png',
                lastSeen: new Date()
            });
            await userProfile.save();
        } else {
            // Update last seen and socket
            userProfile.lastSeen = new Date();
            userProfile.socketId = socket.id;
            await userProfile.save();
        }

        users[socket.id] = { 
            username: userProfile.username, 
            displayName: userProfile.displayName, 
            avatar: userProfile.avatar,
            ip: clientIp
        };

        io.emit('update-user-list', Object.values(users));
        
        // Notify others
        io.emit('chat-message', formatMessage('System', `${userProfile.displayName} (${username}) has joined the chat.`));
        io.emit('user-status-change', { username: username, online: true });
    });

    // Handle Profile Updates
    socket.on('update-profile', async (data) => {
        const currentUser = users[socket.id];
        if (!currentUser) return;

        try {
            const updatedUser = await User.findOneAndUpdate(
                { username: currentUser.username },
                { 
                    displayName: data.displayName,
                    pronouns: data.pronouns,
                    description: data.description,
                    avatar: data.avatar,
                    banner: data.banner,
                    customBackground: data.customBackground
                },
                { new: true }
            );
            
            // Update local memory
            users[socket.id].displayName = updatedUser.displayName;
            users[socket.id].avatar = updatedUser.avatar;

            io.emit('update-user-list', Object.values(users));
            socket.emit('profile-updated', 'Profile saved successfully!');
        } catch (e) {
            console.error(e);
        }
    });

    // Handle Profile Fetch (For viewing others)
    socket.on('get-user-profile', async (targetUsername) => {
        const profile = await User.findOne({ username: targetUsername });
        if (profile) {
            socket.emit('user-profile-data', profile);
        } else {
            socket.emit('user-profile-data', { notFound: true });
        }
    });

    // --- CHAT MESSAGES ---
    socket.on('chat-message', async (payload) => {
        const userData = users[socket.id] || { username: 'Anonymous', displayName: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;
        const senderDisplayName = userData.displayName || sender;

        if (mutedUsers.has(sender.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are currently muted.'));
            return;
        }

        let msgText = '';
        let msgImage = null;
        let replyTo = null;
        let targetUsername = null; // DM Target

        if (typeof payload === 'string') { msgText = payload; } 
        else if (typeof payload === 'object') {
            msgText = payload.text || ''; 
            msgImage = payload.image || null; 
            replyTo = payload.replyTo || null;
            targetUsername = payload.target || null; // Capture Target
        }

        // --- DM ROUTING LOGIC ---
        if (targetUsername) {
            const recipientId = findSocketIdByUsername(targetUsername);
            
            // Format as a private message (isPm = true logic handled in client usually, but here we flag it)
            // Note: Reuse formatMessage, but we will send via specific event 'dm-received'
            const dmMsg = formatMessage(sender, msgText, userData.avatar, msgImage, true, replyTo, senderDisplayName);
            
            const dmPayload = {
                from: sender,
                to: targetUsername,
                message: dmMsg
            };

            // 1. Send to Sender (so it appears in your own chat)
            socket.emit('dm-received', dmPayload);

            // 2. Send to Recipient (if online)
            if (recipientId) {
                io.to(recipientId).emit('dm-received', dmPayload);
            }
            // Stop broadcast
            return; 
        }

        // --- SLASH COMMANDS ---
        if (msgText.startsWith('/')) {
            const args = msgText.slice(1).split(' ');
            const command = args.shift().toLowerCase();

            if (command === 'clear' && sender === 'kl_') {
                await Message.deleteMany({});
                io.emit('clear-chat');
                return;
            }
            if (command === 'ban' && sender === 'kl_') {
                const target = args[0];
                const targetSocketId = Object.keys(users).find(id => users[id].username === target);
                if (targetSocketId) {
                    const targetIp = users[targetSocketId].ip;
                    bannedIPs.add(targetIp);
                    await new Ban({ ip: targetIp, reason: 'Banned by admin' }).save();
                    io.to(targetSocketId).emit('banned', 'You have been banned.');
                    io.sockets.sockets.get(targetSocketId)?.disconnect();
                    io.emit('chat-message', formatMessage('System', `User ${target} has been banned.`));
                }
                return;
            }
            if (command === 'mute' && sender === 'kl_') {
                const target = args[0];
                mutedUsers.add(target.toLowerCase());
                io.emit('chat-message', formatMessage('System', `User ${target} has been muted.`));
                return;
            }
            if (command === 'unmute' && sender === 'kl_') {
                const target = args[0];
                mutedUsers.delete(target.toLowerCase());
                io.emit('chat-message', formatMessage('System', `User ${target} has been unmuted.`));
                return;
            }
            if (command === 'help') {
                socket.emit('chat-message', formatMessage('System', 'Commands: /clear, /ban [user], /mute [user], /unmute [user] (Admin only)'));
                return;
            }
        }

        // --- PUBLIC BROADCAST ---
        const message = new Message({
            sender: sender,
            displayName: senderDisplayName,
            avatar: userData.avatar,
            text: msgText,
            image: msgImage,
            replyTo: replyTo
        });
        
        await message.save();
        io.emit('chat-message', message);
    });

    // --- VOICE CHAT EVENTS ---
    socket.on('join-vc', () => {
        const user = users[socket.id];
        if (user && !vcUsers[socket.id]) {
            vcUsers[socket.id] = user.username;
            broadcastVCUserList();
            socket.broadcast.emit('vc-user-joined', socket.id);
        }
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            broadcastVCUserList();
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    // WebRTC Signaling
    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', {
            sender: socket.id,
            signal: data.signal
        });
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const username = user.username.toLowerCase();
            delete users[socket.id];
            
            if (vcUsers[socket.id]) { 
                delete vcUsers[socket.id]; 
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id); 
            }

            // --- GRACE PERIOD LOGIC ---
            if (disconnectTimeouts[username]) clearTimeout(disconnectTimeouts[username]);

            disconnectTimeouts[username] = setTimeout(() => {
                const isStillOnline = Object.values(users).some(u => u.username.toLowerCase() === username);
                
                if (!isStillOnline) {
                    const leaveMsg = formatMessage('System', `${user.displayName} (${user.username}) has left.`);
                    io.emit('chat-message', leaveMsg); 
                    // Note: We don't save "left" messages to DB history to avoid clutter, but you can if you want.
                    // savePublicMessage(leaveMsg); 
                    io.emit('user-status-change', { username: user.username, online: false });
                }
                delete disconnectTimeouts[username];
            }, 2000); 
        }
    });
});

app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try { await Ban.deleteMany({}); bannedIPs.clear(); res.send("SUCCESS"); } catch (e) { res.send(e.message); }
});

function formatMessage(username, text, avatar = 'placeholder-avatar.png', image = null, isPm = false, replyTo = null, displayName = null) {
    return {
        sender: username,
        displayName: displayName || username,
        text,
        image,
        avatar,
        timestamp: new Date(),
        isSystem: username === 'System',
        replyTo,
        isPm // Helper flag for frontend (though handled by event type too)
    };
}

function broadcastVCUserList() {
    io.emit('update-vc-list', Object.values(vcUsers));
}

// Helper to find socket ID by username
function findSocketIdByUsername(username) {
    const entry = Object.entries(users).find(([id, user]) => user.username.toLowerCase() === username.toLowerCase());
    return entry ? entry[0] : null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
