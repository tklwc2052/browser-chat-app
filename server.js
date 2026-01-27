require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const fs = require('fs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

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

// Multer config
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } 
});

const io = socketIo(server, { maxHttpBufferSize: 1e8 });

// --- MONGOOSE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB error:', err));

// --- SCHEMAS ---
const messageSchema = new mongoose.Schema({
    sender: String,
    senderDisplayName: String,
    avatar: String,
    text: String,
    image: String,
    time: String,
    timestamp: { type: Date, default: Date.now },
    isEdited: { type: Boolean, default: false },
    replyTo: { type: Object, default: null } 
});

const privateMessageSchema = new mongoose.Schema({
    from: String,
    to: String,
    message: Object, 
    timestamp: { type: Date, default: Date.now }
});

const banSchema = new mongoose.Schema({
    ip: String,
    reason: String,
    timestamp: { type: Date, default: Date.now }
});

// REVERTED TO 'User' TO RESTORE YOUR OLD DATA
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true }, 
    displayName: String, 
    avatar: String,
    banner: { type: String, default: "" },
    pronouns: { type: String, default: "" },
    description: { type: String, default: "" },
    customBackground: { type: String, default: "" },
    lastSeen: { type: Date, default: Date.now },
    lastIp: String
});

const Message = mongoose.model('Message', messageSchema);
const PrivateMessage = mongoose.model('PrivateMessage', privateMessageSchema);
const Ban = mongoose.model('Ban', banSchema);
// Pointing back to the original 'User' model
const User = mongoose.models.User || mongoose.model('User', userSchema);

// --- SERVE STATIC FILES ---
app.use(express.static(path.join(__dirname, 'public')));

// --- ROUTES ---
app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/voice', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'voice.html'));
});

app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try { await Ban.deleteMany({}); bannedIPs.clear(); res.send("SUCCESS"); } catch (e) { res.send(e.message); }
});

// --- STATE MANAGEMENT ---
const users = {}; 
const vcUsers = {}; 
const bannedIPs = new Set();
const disconnectTimeouts = {}; 

// Load Bans
Ban.find().then(bans => bans.forEach(b => bannedIPs.add(b.ip)));

// --- SOCKET.IO LOGIC ---
io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    if (bannedIPs.has(clientIp)) {
        socket.emit('system-message', 'You are banned.');
        socket.disconnect();
        return;
    }

    socket.emit('motd', `Server Build: ${SERVER_BUILD_ID} - ${SERVER_BUILD_DESC}`);

    // --- USERNAME HANDLER ---
    socket.on('set-username', async (data) => {
        const username = data.username;
        const lowerName = username.toLowerCase();

        // 1. Fetch or Create User (Using correct 'User' model now)
        let profile = await User.findOne({ username: username });
        if (!profile) {
            profile = new User({ 
                username: username, 
                displayName: username, 
                avatar: `https://ui-avatars.com/api/?name=${username}&background=random`,
                description: "New user",
                lastIp: clientIp
            });
            await profile.save();
        } else {
            // Update IP on login
            profile.lastIp = clientIp;
            await profile.save();
        }

        // 2. Handle Reconnection
        if (disconnectTimeouts[lowerName]) {
            clearTimeout(disconnectTimeouts[lowerName]);
            delete disconnectTimeouts[lowerName];
        }

        // 3. Update Socket State
        users[socket.id] = { 
            username: profile.username, 
            displayName: profile.displayName,
            avatar: profile.avatar,
            online: true,
            ip: clientIp 
        };

        // 4. Send Data to Client
        socket.emit('profile-info', {
            username: profile.username,
            displayName: profile.displayName,
            avatar: profile.avatar,
            description: profile.description,
            pronouns: profile.pronouns,
            banner: profile.banner,
            customBackground: profile.customBackground
        });

        // 5. Broadcast Presence
        io.emit('user-status-change', { 
            username: profile.username, 
            displayName: profile.displayName,
            avatar: profile.avatar, 
            online: true 
        });
        
        // 6. Send User List
        const userList = await User.find({});
        const onlineMap = {};
        Object.values(users).forEach(u => onlineMap[u.username] = true);
        
        const refinedList = userList.map(u => ({
            username: u.username,
            displayName: u.displayName,
            avatar: u.avatar,
            online: !!onlineMap[u.username]
        }));
        
        socket.emit('sidebar-user-list', refinedList);
        socket.emit('vc-user-list-update', Object.values(vcUsers));
    });

    // --- PROFILE FETCHING ---
    socket.on('get-user-profile', async (targetUsername) => {
        const p = await User.findOne({ username: targetUsername });
        if(p) socket.emit('user-profile-data', p);
        else socket.emit('user-profile-data', { notFound: true });
    });

    // --- UPDATE PROFILE (FIXED) ---
    socket.on('update-profile', async (data) => {
        const user = users[socket.id];
        if(!user || user.username !== data.username) return;

        // Upload Banner
        let bannerUrl = data.banner;
        if (data.banner && data.banner.startsWith('data:image')) {
            try {
                const result = await cloudinary.uploader.upload(data.banner, { folder: "chat_banners" });
                bannerUrl = result.secure_url;
            } catch(e) { console.error("Banner upload failed", e); }
        }

        // Upload Custom BG
        let bgUrl = data.customBackground;
        if (data.customBackground && data.customBackground.startsWith('data:image')) {
             try {
                const result = await cloudinary.uploader.upload(data.customBackground, { folder: "chat_bgs" });
                bgUrl = result.secure_url;
            } catch(e) { console.error("BG upload failed", e); }
        }

        // Database Update
        const updateFields = {
            displayName: data.displayName,
            pronouns: data.pronouns,
            description: data.description,
            banner: bannerUrl,
            customBackground: bgUrl
        };

        // FIX: Ensure Avatar is updated if provided
        if (data.avatar) {
            updateFields.avatar = data.avatar;
            user.avatar = data.avatar; // Update local session
        }

        await User.findOneAndUpdate({ username: data.username }, updateFields);

        // Update local session
        user.displayName = data.displayName;
        
        // Notify everyone
        io.emit('user-status-change', { 
            username: data.username, 
            displayName: data.displayName,
            avatar: user.avatar, 
            online: true 
        });
        
        socket.emit('profile-update-success');
    });

    // --- CHAT MESSAGING ---
    socket.on('chat-message', async (data) => {
        const user = users[socket.id];
        if (!user) return;

        // Image Handling
        let imageUrl = null;
        if (data.image) {
            try {
                const uploadRes = await cloudinary.uploader.upload(data.image, { folder: "chat_images" });
                imageUrl = uploadRes.secure_url;
            } catch (err) {
                console.error("Cloudinary Error:", err);
            }
        }

        const msgData = {
            sender: user.username,
            senderDisplayName: user.displayName,
            avatar: user.avatar,
            text: data.text,
            image: imageUrl,
            time: new Date().toLocaleTimeString(),
            timestamp: new Date(),
            replyTo: data.replyTo || null
        };

        if (data.to) {
            // PRIVATE MESSAGE
            const pm = new PrivateMessage({
                from: user.username,
                to: data.to,
                message: msgData
            });
            await pm.save();

            const recipientSocketId = Object.keys(users).find(key => users[key].username === data.to);
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('dm-received', { from: user.username, to: data.to, message: msgData });
            }
            socket.emit('dm-received', { from: user.username, to: data.to, message: msgData });

        } else {
            // GLOBAL MESSAGE
            const newMsg = new Message(msgData);
            await newMsg.save();
            const savedMsg = newMsg.toObject();
            savedMsg.id = newMsg._id;
            
            io.emit('chat-message', savedMsg);
        }
    });

    // --- MESSAGE HISTORY ---
    socket.on('get-history', async () => {
        const history = await Message.find().sort({ timestamp: 1 }).limit(100);
        const historyWithIds = history.map(h => {
            const doc = h.toObject();
            doc.id = h._id;
            return doc;
        });
        socket.emit('history', historyWithIds);
    });

    socket.on('fetch-dm-history', async (targetUser) => {
        const currentUser = users[socket.id];
        if(!currentUser) return;
        
        const dms = await PrivateMessage.find({
            $or: [
                { from: currentUser.username, to: targetUser },
                { from: targetUser, to: currentUser.username }
            ]
        }).sort({ timestamp: 1 }).limit(50);
        
        const messages = dms.map(d => d.message);
        socket.emit('dm-history', { target: targetUser, messages });
    });

    // --- EDIT / DELETE ---
    socket.on('delete-message', async (id) => {
        const user = users[socket.id];
        if(!user) return;
        const msg = await Message.findById(id);
        if(msg && (msg.sender === user.username || user.username === 'Admin')) {
            await Message.findByIdAndDelete(id);
            io.emit('message-deleted', id);
        }
    });

    socket.on('edit-message', async (data) => {
        const user = users[socket.id];
        if(!user) return;
        const msg = await Message.findById(data.id);
        if(msg && msg.sender === user.username) {
            msg.text = data.newText;
            msg.isEdited = true;
            await msg.save();
            io.emit('message-updated', { id: msg._id, text: msg.text });
        }
    });

    // --- TYPING ---
    socket.on('typing', (target) => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('typing', user.displayName); 
    });
    socket.on('stop-typing', () => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('stop-typing', user.displayName);
    });

    // --- VOICE CHAT ---
    socket.on('join-vc', () => {
        if (!users[socket.id]) return;
        vcUsers[socket.id] = users[socket.id];
        io.emit('vc-user-list-update', Object.values(vcUsers));
        socket.broadcast.emit('vc-user-joined', socket.id);
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list-update', Object.values(vcUsers));
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', {
            signal: data.signal,
            sender: socket.id
        });
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const username = user.username.toLowerCase();
            delete users[socket.id];
            
            if (vcUsers[socket.id]) { 
                delete vcUsers[socket.id]; 
                io.emit('vc-user-list-update', Object.values(vcUsers));
                socket.broadcast.emit('vc-user-left', socket.id); 
            }

            if (disconnectTimeouts[username]) clearTimeout(disconnectTimeouts[username]);

            disconnectTimeouts[username] = setTimeout(async () => {
                const isStillOnline = Object.values(users).some(u => u.username.toLowerCase() === username);
                if (!isStillOnline) {
                    await User.findOneAndUpdate({ username: user.username }, { lastSeen: new Date() });
                    io.emit('user-status-change', { username: user.username, online: false });
                }
                delete disconnectTimeouts[username];
            }, 2000); 
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
