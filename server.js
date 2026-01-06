require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// --- CONFIGURATION ---
ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const server = http.createServer(app);

// --- 1. UPLOAD HANDLING (Multer) ---
// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// Limit uploads to 1GB
const upload = multer({
    storage: storage,
    limits: { fileSize: 1024 * 1024 * 1024 } 
});

// --- 2. AUTOMATIC UPDATE MESSAGE ---
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

// Increase Socket Buffer to 100MB just in case, though we use HTTP for uploads now
const io = socketIo(server, {
    maxHttpBufferSize: 1e8 
});

app.set('trust proxy', 1);

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        try {
            const savedMessages = await Message.find()
                .sort({ timestamp: -1 })
                .limit(MAX_HISTORY)
                .lean();
            messageHistory.push(...savedMessages.reverse());
            console.log(`Loaded ${savedMessages.length} past messages.`);
        } catch (err) { console.error("Error loading chat history:", err); }

        try {
            const savedMotd = await Config.findOne({ key: 'motd' });
            if (savedMotd) serverMOTD = savedMotd.value;
        } catch (err) { console.error("Error loading MOTD:", err); }

        try {
            const allBans = await Ban.find({});
            allBans.forEach(ban => bannedIPs.set(ban.ip, true));
        } catch (err) { console.error("Error loading bans:", err); }
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    avatar: String,
    lastIp: String,
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const banSchema = new mongoose.Schema({
    username: String,
    ip: String,
    bannedAt: { type: Date, default: Date.now },
    bannedBy: String
});
const Ban = mongoose.model('Ban', banSchema);

const messageSchema = new mongoose.Schema({
    id: String,
    sender: String,
    text: String,
    image: String,
    avatar: String,
    time: String,
    replyTo: Object,
    type: String,
    isEdited: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});
messageSchema.index({ timestamp: -1 });
const Message = mongoose.model('Message', messageSchema);

const dmSchema = new mongoose.Schema({
    participants: [String],
    messages: [{
        id: String,
        replyTo: Object,
        sender: String,
        text: String,
        image: String,
        avatar: String,
        time: String,
        isEdited: { type: Boolean, default: false },
        timestamp: { type: Date, default: Date.now }
    }]
});
dmSchema.index({ participants: 1 });
const DM = mongoose.model('DM', dmSchema);

const configSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: String
});
const Config = mongoose.model('Config', configSchema);

// --- STATE MANAGEMENT ---
const users = {};
const vcUsers = {};
const messageHistory = [];
const MAX_HISTORY = 20;
const userAvatarCache = {};
let serverMOTD = "Welcome to the C&C Corp chat! Play nice.";
const mutedUsers = new Set();
const bannedIPs = new Map();
const ADMIN_USERNAME = 'kl_';

// --- UTILITY FUNCTIONS ---
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatMessage(sender, text, avatar = null, image = null, isPm = false, replyTo = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    let finalAvatar = avatar;
    if (!finalAvatar && userAvatarCache[sender]) finalAvatar = userAvatarCache[sender];
    if (!finalAvatar && sender !== 'System') finalAvatar = 'placeholder-avatar.png';

    if (sender === 'System' || sender === 'Announcement') {
        return { 
            id: generateId(), text: text, sender: sender, avatar: null, time: time, type: 'system', timestamp: now
        };
    }
    
    return {
        id: generateId(), text: text, image: image, sender: sender, avatar: finalAvatar, 
        time: time, replyTo: replyTo, type: isPm ? 'pm' : 'general', isEdited: false, timestamp: now
    };
}

async function savePublicMessage(msgObj) {
    if (msgObj.type === 'pm') return;
    try {
        const newMsg = new Message({
            id: msgObj.id, sender: msgObj.sender, text: msgObj.text, image: msgObj.image,
            avatar: msgObj.avatar, time: msgObj.time, replyTo: msgObj.replyTo, type: msgObj.type,
            isEdited: msgObj.isEdited || false, timestamp: msgObj.timestamp || new Date()
        });
        await newMsg.save();
    } catch (err) { console.error("Error saving public message:", err); }
}

function getDmKey(user1, user2) { return [user1, user2].sort(); }
function broadcastVCUserList() { io.emit('vc-user-list-update', Object.values(vcUsers)); }
function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
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
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        io.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar update error", err); }
}

app.use(express.static(path.join(__dirname, 'public')));

// --- NEW ROUTE: HANDLE IMAGE UPLOADS & CONVERT GIFS ---
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const originalName = req.file.originalname;

    // Check if it is a GIF
    if (originalName.toLowerCase().endsWith('.gif')) {
        const outputPath = inputPath + '.mp4';
        const publicUrl = '/uploads/' + req.file.filename + '.mp4';

        console.log(`🎬 Converting GIF to MP4: ${originalName}`);

        ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .outputOptions([
                '-pix_fmt yuv420p',
                '-preset ultrafast', // Fast conversion
                '-movflags +faststart', // Allow immediate playback
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2' // Ensure even dimensions
            ])
            .noAudio()
            .on('end', () => {
                console.log('✅ Conversion complete!');
                // Delete original GIF to save space? Optional.
                // fs.unlinkSync(inputPath); 
                res.json({ url: publicUrl, type: 'video' });
            })
            .on('error', (err) => {
                console.error('❌ Conversion error:', err);
                res.status(500).send('Error converting file.');
            })
            .run();
    } else {
        // Standard Image
        res.json({ url: '/uploads/' + req.file.filename, type: 'image' });
    }
});

io.on('connection', async (socket) => {
    socket.emit('system-version-check', { id: SERVER_BUILD_ID, description: SERVER_BUILD_DESC });

    const clientIp = getClientIp(socket);
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    socket.emit('history', messageHistory);
    broadcastVCUserList();
    broadcastSidebarRefresh();
    setTimeout(() => { socket.emit('motd', serverMOTD); }, 100);

    socket.on('get-history', () => { socket.emit('history', messageHistory); });

    socket.on('set-username', async ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        const newAvatar = avatar || 'placeholder-avatar.png';

        if (!username) return;
        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.keys(users).some(id => 
            id !== socket.id && users[id].username.toLowerCase() === usernameLower
        );

        if (isDuplicate) {
            socket.emit('chat-message', formatMessage('System', `The username '${username}' is already taken.`));
            return;
        }

        userAvatarCache[username] = newAvatar;
        users[socket.id] = { username, avatar: newAvatar, id: socket.id };

        try {
            await User.findOneAndUpdate(
                { username: username },
                { avatar: newAvatar, lastSeen: Date.now(), lastIp: clientIp },
                { upsert: true, new: true }
            );
        } catch(e) { console.error("DB Save Error", e); }

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }

        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User ${username} joined the chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            savePublicMessage(joinMsg);
            broadcastSidebarRefresh();
        }
        io.emit('user-status-change', { username: username, online: true, avatar: newAvatar });
    });

    socket.on('chat-message', async (payload) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;

        if (mutedUsers.has(sender.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are currently muted.'));
            return;
        }

        let msgText = '';
        let msgImage = null;
        let replyTo = null;

        if (typeof payload === 'string') {
            msgText = payload;
        } else if (typeof payload === 'object') {
            msgText = payload.text || '';
            msgImage = payload.image || null;
            replyTo = payload.replyTo || null;
        }

        // --- COMMANDS ---
        if (msgText.startsWith('/')) {
            const parts = msgText.trim().slice(1).split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);

            // ADMIN CHECKS
            if (['ban', 'unban', 'mute', 'unmute', 'motd', 'prune'].includes(command)) {
                if (sender !== ADMIN_USERNAME) {
                    socket.emit('chat-message', formatMessage('System', 'You do not have permission to use this command.'));
                    return;
                }
            }

            if (command === 'motd') {
                if (args.length === 0) {
                    socket.emit('chat-message', formatMessage('System', `Current MOTD: ${serverMOTD}`));
                } else {
                    const newMotd = args.join(' ');
                    serverMOTD = newMotd;
                    await Config.findOneAndUpdate({ key: 'motd' }, { value: newMotd }, { upsert: true });
                    io.emit('motd', newMotd);
                    io.emit('chat-message', formatMessage('System', `MOTD updated: ${newMotd}`));
                }
                return;
            }
            if (command === 'prune') {
                 messageHistory.length = 0;
                 await Message.deleteMany({});
                 io.emit('chat-message', formatMessage('System', 'Chat history has been pruned.'));
                 io.emit('history', []);
                 return;
            }
            if (command === 'ban') {
                const targetName = args[0];
                if (!targetName) return;
                const targetSocketId = Object.keys(users).find(id => users[id].username.toLowerCase() === targetName.toLowerCase());
                if (targetSocketId) {
                    const targetIp = getClientIp(io.sockets.sockets.get(targetSocketId));
                    bannedIPs.set(targetIp, true);
                    await Ban.create({ username: targetName, ip: targetIp, bannedBy: sender });
                    io.to(targetSocketId).emit('chat-message', formatMessage('System', 'You have been banned.'));
                    io.sockets.sockets.get(targetSocketId).disconnect(true);
                    io.emit('chat-message', formatMessage('System', `${targetName} has been banned.`));
                } else {
                     socket.emit('chat-message', formatMessage('System', `User ${targetName} not found online. (Offline bans not impl yet)`));
                }
                return;
            }
            if (command === 'mute') {
                const targetName = args[0];
                if(targetName) {
                    mutedUsers.add(targetName.toLowerCase());
                    io.emit('chat-message', formatMessage('System', `${targetName} has been muted.`));
                }
                return;
            }
            if (command === 'unmute') {
                const targetName = args[0];
                if(targetName) {
                    mutedUsers.delete(targetName.toLowerCase());
                    io.emit('chat-message', formatMessage('System', `${targetName} has been unmuted.`));
                }
                return;
            }
        }

        // --- NORMAL MESSAGE ---
        const fullMsg = formatMessage(sender, msgText, userData.avatar, msgImage, false, replyTo);
        io.emit('chat-message', fullMsg);
        addToHistory(fullMsg);
        savePublicMessage(fullMsg);
    });

    socket.on('send-dm', async (data) => {
        const sender = users[socket.id]?.username;
        if (!sender) return;
        const targetUsername = data.target;
        const text = data.text;
        const image = data.image; 
        const replyTo = data.replyTo;

        const targetSocketId = Object.keys(users).find(id => users[id].username === targetUsername);
        
        const dmMsg = formatMessage(sender, text, users[socket.id].avatar, image, true, replyTo);

        socket.emit('dm-message', { sender: sender, target: targetUsername, message: dmMsg });
        if (targetSocketId) {
            io.to(targetSocketId).emit('dm-message', { sender: sender, target: targetUsername, message: dmMsg });
        }

        try {
            const participants = [sender, targetUsername].sort();
            await DM.findOneAndUpdate(
                { participants: participants },
                { 
                    $push: { messages: dmMsg }, 
                    $setOnInsert: { participants: participants } 
                },
                { upsert: true }
            );
        } catch (e) { console.error("DM Save Error", e); }
    });

    // --- OTHER HANDLERS ---
    socket.on('typing', (data) => {
        const targetMode = data.mode || 'global';
        socket.broadcast.emit('typing', { 
            username: users[socket.id]?.username, 
            mode: targetMode,
            target: data.target
        });
    });

    socket.on('fetch-dm-history', async (targetUser) => {
        const sender = users[socket.id]?.username;
        if(!sender) return;
        try {
            const participants = [sender, targetUser].sort();
            const dmDoc = await DM.findOne({ participants: participants }).lean();
            if(dmDoc && dmDoc.messages) {
                socket.emit('dm-history', { target: targetUser, messages: dmDoc.messages });
            } else {
                socket.emit('dm-history', { target: targetUser, messages: [] });
            }
        } catch(e) { console.error("DM Fetch Error", e); }
    });

    socket.on('join-vc', () => {
        if (!users[socket.id]) return;
        vcUsers[socket.id] = users[socket.id];
        broadcastVCUserList();
        socket.broadcast.emit('vc-user-joined', socket.id);
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            broadcastVCUserList();
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
    });
    
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList();
                socket.broadcast.emit('vc-user-left', socket.id);
            }
            const leaveMsg = formatMessage('System', `${user.username} has left.`);
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            savePublicMessage(leaveMsg);
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });
});

// --- EMERGENCY UNBAN ---
app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try {
        await Ban.deleteMany({});
        bannedIPs.clear();
        res.send("<h1>SUCCESS!</h1><p>All bans have been deleted.</p>");
    } catch (e) { res.send("Error: " + e.message); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
