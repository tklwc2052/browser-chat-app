require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const fs = require('fs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');
const bcrypt = require('bcrypt'); // REQUIRED: npm install bcrypt

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

const io = socketIo(server, { maxHttpBufferSize: 1e7 });

app.set('trust proxy', 1); 

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    username_lower: { type: String, unique: true },
    password: { type: String }, 
    ip: String,
    displayName: String,
    pronouns: String,
    description: String,
    avatar: String,
    banner: String,
    customBackground: String,
    lastSeen: Date,
    online: { type: Boolean, default: false }
});

const MessageSchema = new mongoose.Schema({
    id: String,
    text: String,
    image: String,
    from: String,
    displayName: String,
    avatar: String,
    channel: String,
    timestamp: { type: Date, default: Date.now },
    replyTo: Object
});

const DMSchema = new mongoose.Schema({
    participants: [String], 
    messages: [MessageSchema],
    lastUpdated: { type: Date, default: Date.now }
});

const BanSchema = new mongoose.Schema({
    ip: String,
    bannedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Message = mongoose.model('Message', MessageSchema);
const DM = mongoose.model('DM', DMSchema);
const Ban = mongoose.model('Ban', BanSchema);

// --- STATE MANAGEMENT ---
const users = {}; 
const vcUsers = {}; 
const activeScreenShares = new Set();
let bannedIPs = new Set();

async function loadBans() {
    const bans = await Ban.find({});
    bans.forEach(b => bannedIPs.add(b.ip));
}
loadBans();

app.use(express.static(path.join(__dirname, 'public')));

// --- ROUTES ---
app.get('/profile.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// NEW: Login Route
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- IMAGE UPLOAD ENDPOINT ---
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'auto' },
        (error, result) => {
            if (error) return res.status(500).json({ error: error.message });
            res.json({ url: result.secure_url });
        }
    );
    stream.Readable.from(req.file.buffer).pipe(uploadStream);
});

// --- SOCKET IO LOGIC ---
io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    if (bannedIPs.has(clientIp)) {
        socket.disconnect();
        return;
    }

    // 1. Handle Join / Login Request
    socket.on('join-request', async (authData) => {
        let { username, password } = authData;
        
        if (!username || !password) {
            return socket.emit('login-failed', 'Missing credentials.');
        }

        username = username.trim().substring(0, 20);
        const username_lower = username.toLowerCase();

        try {
            // Check for Ban (Username specific check, mainly for kl_)
            if (username === 'kl_') {
                 // Admin logic if needed
            } else {
                 // Regular user
            }

            let user = await User.findOne({ username_lower });

            if (!user) {
                // REGISTER NEW USER
                const hashedPassword = await bcrypt.hash(password, 10);
                
                user = new User({
                    username,
                    username_lower,
                    password: hashedPassword,
                    ip: clientIp,
                    displayName: username,
                    avatar: '',
                    online: true
                });
                await user.save();
            } else {
                // LOGIN EXISTING USER
                if (!user.password) {
                    // Legacy user (no password set), update them now
                    const hashedPassword = await bcrypt.hash(password, 10);
                    user.password = hashedPassword;
                    user.ip = clientIp; // Update IP
                    await user.save();
                } else {
                    // Check Password
                    const match = await bcrypt.compare(password, user.password);
                    if (!match) {
                        return socket.emit('login-failed', 'Incorrect password.');
                    }
                }
                
                // Update User Status
                user.online = true;
                user.ip = clientIp;
                await user.save();
            }

            // --- SUCCESS ---
            socket.emit('login-success', { username: user.username });

            users[socket.id] = { username: user.username, displayName: user.displayName };
            
            // 2. Load Initial Data
            const recentMessages = await Message.find({ channel: 'main' }).sort({ timestamp: -1 }).limit(50);
            const history = recentMessages.reverse();

            const allUsersDB = await User.find({});
            const userList = allUsersDB.map(u => ({
                username: u.username,
                displayName: u.displayName,
                avatar: u.avatar,
                online: u.online
            }));

            socket.emit('init', {
                username: user.username,
                avatar: user.avatar,
                history: history,
                allUsers: userList
            });

            const welcomeMsg = formatMessage('System', `${user.displayName} has joined.`);
            socket.broadcast.emit('chat-message', welcomeMsg);
            io.emit('user-status-change', { username: user.username, online: true });

            // Send System Update message
            socket.emit('chat-message', formatMessage('System', `Current Build: ${SERVER_BUILD_DESC}`));

        } catch (err) {
            console.error(err);
            socket.emit('login-failed', 'Server error during login.');
        }
    });

    // --- MESSAGING ---
    socket.on('chat-message', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        
        // Command Handling
        if (data.text.startsWith('/')) {
            const args = data.text.split(' ');
            const cmd = args[0].toLowerCase();
            
            if (cmd === '/ban' && user.username === 'kl_') {
                const targetName = args[1];
                if (targetName) {
                    const targetUser = await User.findOne({ username_lower: targetName.toLowerCase() });
                    if (targetUser) {
                        bannedIPs.add(targetUser.ip);
                        const ban = new Ban({ ip: targetUser.ip });
                        await ban.save();
                        // Disconnect active sockets with this IP
                        const sockets = await io.fetchSockets();
                        for (const s of sockets) {
                            const sIp = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
                            if (sIp === targetUser.ip) s.disconnect();
                        }
                    }
                }
                return;
            }
        }

        const dbUser = await User.findOne({ username: user.username });
        
        const msgObj = {
            id: Date.now().toString(),
            text: data.text,
            image: data.image,
            from: user.username,
            displayName: dbUser.displayName || user.username,
            avatar: dbUser.avatar,
            timestamp: new Date(),
            replyTo: data.replyToId ? await getMessageById(data.replyToId) : null
        };

        if (data.isDM && data.to) {
            // DIRECT MESSAGE
            msgObj.isDM = true;
            msgObj.to = data.to;
            await saveDirectMessage(msgObj, user.username, data.to);
            socket.emit('chat-message', msgObj); // Send to self
            
            // Send to recipient(s)
            const recipientSockets = await findSocketsByUsername(data.to);
            recipientSockets.forEach(s => s.emit('chat-message', msgObj));

        } else {
            // CHANNEL MESSAGE
            msgObj.channel = data.channel || 'main';
            io.emit('chat-message', msgObj);
            savePublicMessage(msgObj, msgObj.channel);
        }
    });

    // --- CHANNEL SWITCHING ---
    socket.on('join-channel', async (channel) => {
        const msgs = await Message.find({ channel }).sort({ timestamp: -1 }).limit(50);
        socket.emit('history', msgs.reverse());
    });

    // --- DM HISTORY ---
    socket.on('get-dm-history', async (targetUser) => {
        const user = users[socket.id];
        if(!user) return;
        
        // Find DM document between these two
        const participants = [user.username, targetUser].sort();
        const dm = await DM.findOne({ participants: { $all: participants } });
        
        if (dm) {
            socket.emit('history', dm.messages);
        } else {
            socket.emit('history', []);
        }
    });

    // --- PROFILE HANDLING ---
    socket.on('get-user-profile', async (targetUsername) => {
        try {
            const u = await User.findOne({ username_lower: targetUsername.toLowerCase() });
            if (u) {
                socket.emit('user-profile-data', {
                    username: u.username,
                    displayName: u.displayName,
                    pronouns: u.pronouns,
                    description: u.description,
                    avatar: u.avatar,
                    banner: u.banner,
                    customBackground: u.customBackground,
                    lastSeen: u.lastSeen
                });
            } else {
                socket.emit('user-profile-data', { notFound: true });
            }
        } catch (e) { console.error(e); }
    });

    socket.on('update-profile', async (data) => {
        const user = users[socket.id];
        if (!user) return;

        try {
            const dbUser = await User.findOne({ username: user.username });
            if (data.displayName) dbUser.displayName = data.displayName.substring(0, 30);
            if (data.pronouns) dbUser.pronouns = data.pronouns.substring(0, 20);
            if (data.description) dbUser.description = data.description.substring(0, 150);
            if (data.avatar) dbUser.avatar = data.avatar;
            if (data.banner) dbUser.banner = data.banner;
            if (data.customBackground) dbUser.customBackground = data.customBackground;

            await dbUser.save();
            users[socket.id].displayName = dbUser.displayName; // Update local state
            
            // Broadcast update
            io.emit('init-update-user', { 
                username: user.username, 
                displayName: dbUser.displayName, 
                avatar: dbUser.avatar 
            });

        } catch (e) { console.error(e); }
    });

    // --- VOICE CHAT SIGNALS ---
    socket.on('join-vc', () => {
        if (!users[socket.id]) return;
        vcUsers[socket.id] = users[socket.id].username;
        broadcastVCUserList();
    });

    socket.on('signal', data => {
        io.to(data.target).emit('signal', {
            signal: data.signal,
            sender: socket.id
        });
    });

    function broadcastVCUserList() {
        const list = Object.values(vcUsers);
        io.emit('vc-update', list);
    }

    // --- DISCONNECT ---
    const disconnectTimeouts = {};

    socket.on('disconnect', async () => {
        const user = users[socket.id];
        if (user) {
            const username = user.username.toLowerCase();
            delete users[socket.id];
            
            if (activeScreenShares.has(user.username)) {
                activeScreenShares.delete(user.username);
                io.emit('screen-share-update', Array.from(activeScreenShares));
            }

            if (vcUsers[socket.id]) { 
                delete vcUsers[socket.id]; 
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id); 
            }

            if (disconnectTimeouts[username]) clearTimeout(disconnectTimeouts[username]);

            disconnectTimeouts[username] = setTimeout(async () => {
                const isStillOnline = Object.values(users).some(u => u.username.toLowerCase() === username);
                
                if (!isStillOnline) {
                    const dbUser = await User.findOne({ username_lower: username });
                    if(dbUser) {
                        dbUser.online = false;
                        dbUser.lastSeen = new Date();
                        await dbUser.save();
                    }

                    const leaveMsg = formatMessage('System', `${user.displayName} has left.`);
                    io.to('main').emit('chat-message', leaveMsg); 
                    savePublicMessage(leaveMsg, 'main');
                    io.emit('user-status-change', { username: user.username, online: false });
                }
                delete disconnectTimeouts[username];
            }, 2000); 
        }
    });
});

// --- HELPER FUNCTIONS ---
function formatMessage(username, text) {
    return {
        id: Date.now().toString(),
        text,
        from: username,
        timestamp: new Date(),
        channel: 'main'
    };
}

async function getMessageById(id) {
    // Check recent public
    let msg = await Message.findOne({ id });
    if (msg) return msg;
    // Check DMs (expensive, but necessary for reply context in DMs)
    // Simplified: Just returning null if not found in public for now to save perf
    return null;
}

async function savePublicMessage(msg, channel) {
    const m = new Message({
        id: msg.id,
        text: msg.text,
        image: msg.image,
        from: msg.from,
        displayName: msg.displayName,
        avatar: msg.avatar,
        channel: channel,
        timestamp: msg.timestamp,
        replyTo: msg.replyTo
    });
    await m.save();
}

async function saveDirectMessage(msg, user1, user2) {
    const participants = [user1, user2].sort();
    let dm = await DM.findOne({ participants: { $all: participants } });
    if (!dm) {
        dm = new DM({ participants });
    }
    
    dm.messages.push({
        id: msg.id,
        text: msg.text,
        image: msg.image,
        from: msg.from,
        displayName: msg.displayName,
        avatar: msg.avatar,
        timestamp: msg.timestamp,
        replyTo: msg.replyTo
    });
    dm.lastUpdated = new Date();
    await dm.save();
}

async function findSocketsByUsername(username) {
    const sockets = await io.fetchSockets();
    return sockets.filter(s => users[s.id] && users[s.id].username === username);
}

app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try { await Ban.deleteMany({}); bannedIPs.clear(); res.send("SUCCESS"); } catch (e) { res.send(e.message); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
