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
const crypto = require('crypto');
const session = require('express-session');

const app = express();
const server = http.createServer(app);

// --- 1. AUTOMATIC UPDATE MESSAGE ---
let SERVER_BUILD_DESC = "Auth System Added"; 
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
app.use(express.json());

// --- SESSION CONFIG ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'cnc-corp-secret-key-999',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// --- PASSWORD UTILS ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
    const [salt, hash] = storedValue.split(':');
    const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return hash === checkHash;
}

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        try {
            const savedMessages = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
            messageHistory.push(...savedMessages.reverse());
        } catch (err) { console.error(err); }

        try {
            const savedMotd = await Config.findOne({ key: 'motd' });
            if (savedMotd) serverMOTD = savedMotd.value;
        } catch (err) { console.error(err); }

        try {
            const allBans = await Ban.find({});
            allBans.forEach(ban => bannedIPs.set(ban.ip, true));
        } catch (err) { console.error(err); }
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    password: { type: String }, // Added Password
    displayName: String, 
    description: { type: String, default: "" }, 
    pronouns: { type: String, default: "" },
    avatar: String,
    banner: { type: String, default: "" },           
    customBackground: { type: String, default: "" }, 
    lastIp: String, 
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const banSchema = new mongoose.Schema({
    username: String, ip: String, bannedAt: { type: Date, default: Date.now }, bannedBy: String
});
const Ban = mongoose.models.Ban || mongoose.model('Ban', banSchema);

const messageSchema = new mongoose.Schema({
    id: String, 
    sender: String, 
    senderDisplayName: String, 
    text: String, 
    image: String, 
    avatar: String, 
    time: String, 
    replyTo: Object, 
    type: String, 
    channel: { type: String, default: 'main' },
    isEdited: { type: Boolean, default: false }, 
    timestamp: { type: Date, default: Date.now }
});
messageSchema.index({ timestamp: -1 }); 
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

const dmSchema = new mongoose.Schema({
    participants: [String], 
    messages: [{ id: String, replyTo: Object, sender: String, senderDisplayName: String, text: String, image: String, avatar: String, time: String, isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now } }]
});
dmSchema.index({ participants: 1 });
const DM = mongoose.models.DM || mongoose.model('DM', dmSchema);

const configSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String });
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 20; 
const userAvatarCache = {}; 
let serverMOTD = "Welcome to the C&C Corp chat! Play nice."; 
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = 'kl_'; 
const activeScreenShares = new Set(); 
const disconnectTimeouts = {}; 

// --- Utility Functions ---
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function formatMessage(sender, text, avatar = null, image = null, isPm = false, replyTo = null, senderDisplayName = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let finalAvatar = avatar;
    if (!finalAvatar && userAvatarCache[sender]) finalAvatar = userAvatarCache[sender];
    if (!finalAvatar && sender !== 'System') finalAvatar = 'placeholder-avatar.png';
    const finalDisplayName = senderDisplayName || sender;

    if (sender === 'System' || sender === 'Announcement') {
        return { id: generateId(), text, sender, senderDisplayName: sender, avatar: null, time, type: 'system', timestamp: now };
    }
    return { id: generateId(), text, image, sender, senderDisplayName: finalDisplayName, avatar: finalAvatar, time, replyTo, type: isPm ? 'pm' : 'general', isEdited: false, timestamp: now };
}

async function savePublicMessage(msgObj, channel = 'main') {
    if (msgObj.type === 'pm') return;
    try {
        await new Message({
            id: msgObj.id, 
            sender: msgObj.sender, 
            senderDisplayName: msgObj.senderDisplayName, 
            text: msgObj.text, 
            image: msgObj.image, 
            avatar: msgObj.avatar, 
            time: msgObj.time, 
            replyTo: msgObj.replyTo, 
            type: msgObj.type, 
            channel: channel,
            isEdited: msgObj.isEdited || false, 
            timestamp: msgObj.timestamp || new Date()
        }).save();
    } catch (err) { console.error("Error saving public message:", err); }
}

async function savePrivateMessage(sender, target, msgObj) {
    const participants = [sender, target].sort();
    try {
        await DM.findOneAndUpdate(
            { participants: participants },
            { 
                $push: { messages: msgObj }, 
                $setOnInsert: { participants: participants } 
            },
            { upsert: true }
        );
    } catch (e) { console.error("Error saving DM:", e); }
}

function broadcastVCUserList() { io.emit('vc-user-list-update', Object.values(vcUsers)); }
function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}
function findSocketIdByUsername(username) {
    return Object.keys(users).find(id => users[id].username.toLowerCase() === username.toLowerCase());
}
function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address;
}
async function broadcastSidebarRefresh() {
    try {
        const allDbUsers = await User.find({}).lean();
        const sidebarList = allDbUsers.map(u => ({
            username: u.username,
            displayName: u.displayName || u.username, 
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        io.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar update error", err); }
}

app.use(express.static(path.join(__dirname, 'public')));

// --- AUTH ROUTES (NEW) ---
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/me', (req, res) => {
    if (req.session.username) {
        return res.json({ username: req.session.username });
    }
    res.status(401).send("Not logged in");
});

app.post('/auth/register', async (req, res) => {
    const { username, password, displayName } = req.body;
    if (!username || !password || !displayName) return res.status(400).send("Missing fields");

    try {
        const existing = await User.findOne({ username: username.toLowerCase() });
        if (existing) return res.status(400).send("Username taken");

        const newUser = new User({
            username: username.toLowerCase(),
            password: hashPassword(password),
            displayName: displayName,
            avatar: 'placeholder-avatar.png'
        });
        await newUser.save();
        
        req.session.username = newUser.username; // Auto login
        res.send("Registered");
    } catch (e) {
        res.status(500).send("Error registering user");
    }
});

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username: username.toLowerCase() });
        if (user && verifyPassword(password, user.password)) {
            req.session.username = user.username;
            res.send("Logged In");
        } else {
            res.status(401).send("Invalid credentials");
        }
    } catch (e) {
        res.status(500).send("Server error");
    }
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy();
    res.send("Logged out");
});

// --- FILE UPLOAD ROUTE ---
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'chat_assets', resource_type: 'auto' },
        (error, result) => {
            if (error) return res.status(500).json({ error: error.message });
            res.json({ url: result.secure_url });
        }
    );

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);
    bufferStream.pipe(uploadStream);
});

app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/voice', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'voice.html'));
});

io.on('connection', async (socket) => {
    socket.emit('system-version-check', { id: SERVER_BUILD_ID, description: SERVER_BUILD_DESC });
    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    socket.join('main');
    socket.emit('history', messageHistory.filter(m => !m.channel || m.channel === 'main'));
    socket.emit('screen-share-update', Array.from(activeScreenShares));
    
    broadcastVCUserList(); 
    broadcastSidebarRefresh(); 
    setTimeout(() => { socket.emit('motd', serverMOTD); }, 100);

    socket.on('join-channel', async (channelName) => {
        socket.rooms.forEach(room => {
            if(room !== socket.id) socket.leave(room);
        });
        socket.join(channelName);
        const channelHistory = await Message.find({ channel: channelName })
                                           .sort({ timestamp: -1 })
                                           .limit(MAX_HISTORY)
                                           .lean();
        socket.emit('history', channelHistory.reverse());
    });

    socket.on('get-history', () => { 
        socket.emit('history', messageHistory.filter(m => !m.channel || m.channel === 'main')); 
    });

    socket.on('set-username', async ({ username }) => {
        if (!username) return;
        const usernameLower = username.toLowerCase();
        
        // Disconnect old socket if reconnecting fast
        if (disconnectTimeouts[usernameLower]) {
            clearTimeout(disconnectTimeouts[usernameLower]);
            delete disconnectTimeouts[usernameLower];
        }

        // Check DB
        let dbUser = null;
        try { dbUser = await User.findOne({ username: username }); } catch(e) {}

        const displayName = dbUser ? (dbUser.displayName || username) : username;
        const avatar = dbUser ? (dbUser.avatar || 'placeholder-avatar.png') : 'placeholder-avatar.png';
        const description = dbUser ? (dbUser.description || "") : "";
        const pronouns = dbUser ? (dbUser.pronouns || "") : "";
        const banner = dbUser ? (dbUser.banner || "") : "";
        const customBackground = dbUser ? (dbUser.customBackground || "") : "";

        userAvatarCache[username] = avatar;
        users[socket.id] = { username, displayName, avatar, description, pronouns, id: socket.id };

        try {
            await User.findOneAndUpdate(
                { username: username },
                { lastSeen: Date.now(), lastIp: clientIp, $setOnInsert: { displayName: username, avatar: 'placeholder-avatar.png' } },
                { upsert: true, new: true }
            );
        } catch(e) { console.error(e); }

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].displayName = displayName;
            vcUsers[socket.id].avatar = avatar;
            broadcastVCUserList();
        }
        
        // Announce Join
        const joinMsg = formatMessage('System', `${displayName} (${username}) joined the chat.`);
        io.to('main').emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        savePublicMessage(joinMsg, 'main'); 

        broadcastSidebarRefresh();
        
        socket.emit('profile-info', { 
            username, displayName, avatar, description, pronouns, banner, customBackground 
        });
        
        io.emit('user-status-change', { username, displayName, online: true, avatar });
        
        socket.emit('screen-share-update', Array.from(activeScreenShares));
    });

    socket.on('get-user-profile', async (targetUsername) => {
        try {
            const dbUser = await User.findOne({ username: targetUsername }).lean();
            if (dbUser) {
                socket.emit('user-profile-data', {
                    username: dbUser.username,
                    displayName: dbUser.displayName || dbUser.username,
                    avatar: dbUser.avatar || 'placeholder-avatar.png',
                    description: dbUser.description || "",
                    pronouns: dbUser.pronouns || "",
                    banner: dbUser.banner || "",
                    customBackground: dbUser.customBackground || "",
                    lastSeen: dbUser.lastSeen
                });
            } else {
                socket.emit('user-profile-data', { notFound: true, username: targetUsername });
            }
        } catch (e) {
            console.error("Fetch Profile Error", e);
        }
    });

    socket.on('update-profile', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        
        const { displayName, avatar, description, pronouns, banner, customBackground } = data;
        
        if (displayName) user.displayName = displayName;
        if (avatar) {
            user.avatar = avatar;
            userAvatarCache[user.username] = avatar;
        }
