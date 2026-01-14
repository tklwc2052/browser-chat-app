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

const app = express();
const server = http.createServer(app);

// --- CLOUDINARY CONFIG ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

// --- AUTOMATIC UPDATE MESSAGE ---
let SERVER_BUILD_DESC = "System Update"; 
const SERVER_BUILD_ID = Date.now(); 
try {
    if (fs.existsSync('build_desc.txt')) {
        SERVER_BUILD_DESC = fs.readFileSync('build_desc.txt', 'utf8').trim();
    }
} catch (e) {}

const io = socketIo(server, { maxHttpBufferSize: 1e7 });

app.set('trust proxy', 1); 

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI).then(async () => {
    console.log('MongoDB Connected');
    // Load history
    try {
        const savedMessages = await Message.find().sort({ timestamp: -1 }).limit(50).lean();
        messageHistory.push(...savedMessages.reverse());
    } catch (err) { console.error(err); }
}).catch(err => console.log('MongoDB Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
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

const messageSchema = new mongoose.Schema({
    id: String, sender: String, senderDisplayName: String, text: String, image: String, avatar: String, time: String, replyTo: Object, type: String, isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

const banSchema = new mongoose.Schema({ username: String, ip: String });
const Ban = mongoose.models.Ban || mongoose.model('Ban', banSchema);

// --- STATE ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 
const mutedUsers = new Set(); 
const bannedIPs = new Map();  

// --- UTILS ---
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function formatMessage(sender, text, avatar = null, image = null, isPm = false, replyTo = null, senderDisplayName = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let finalAvatar = avatar || userAvatarCache[sender] || 'placeholder-avatar.png';
    const finalDisplayName = senderDisplayName || sender;

    return { 
        id: generateId(), 
        text, image, sender, 
        senderDisplayName: finalDisplayName, 
        avatar: finalAvatar, 
        time, replyTo, 
        type: isPm ? 'pm' : 'general', 
        isEdited: false, 
        timestamp: now 
    };
}

async function savePublicMessage(msgObj) {
    if (msgObj.type === 'pm') return;
    try {
        await new Message(msgObj).save();
    } catch (err) { console.error("Error saving message:", err); }
}

function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}

function findSocketIdByUsername(username) {
    return Object.keys(users).find(id => users[id].username.toLowerCase() === username.toLowerCase());
}

app.use(express.static(path.join(__dirname, 'public')));

// UPLOAD ENDPOINT
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
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

// --- SOCKET.IO ---
io.on('connection', async (socket) => {
    // Basic Setup
    socket.emit('system-version-check', { id: SERVER_BUILD_ID, description: SERVER_BUILD_DESC });
    socket.emit('history', messageHistory);
    io.emit('vc-user-list-update', Object.values(vcUsers));

    // LOGIN
    socket.on('set-username', async ({ username }) => {
        if (!username) return;
        const dbUser = await User.findOne({ username }).lean();
        
        const displayName = dbUser ? (dbUser.displayName || username) : username;
        const avatar = dbUser ? (dbUser.avatar || 'placeholder-avatar.png') : 'placeholder-avatar.png';
        
        // Cache user info
        userAvatarCache[username] = avatar;
        users[socket.id] = { username, displayName, avatar, id: socket.id };
        
        // Update DB Last Seen
        await User.findOneAndUpdate({ username }, { lastSeen: Date.now(), $setOnInsert: { displayName, avatar: 'placeholder-avatar.png' } }, { upsert: true });

        // Update VC if they were in it (reconnect scenario)
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].displayName = displayName;
            vcUsers[socket.id].avatar = avatar;
            io.emit('vc-user-list-update', Object.values(vcUsers));
        }

        io.emit('user-status-change', { username, displayName, online: true, avatar });
        
        // Send Profile Data back to self (for Profile Page)
        if (dbUser) {
            socket.emit('profile-info', { 
                username, displayName, avatar, 
                description: dbUser.description, pronouns: dbUser.pronouns, 
                banner: dbUser.banner, customBackground: dbUser.customBackground 
            });
        }
    });

    // PROFILE FETCH
    socket.on('get-user-profile', async (targetUsername) => {
        const dbUser = await User.findOne({ username: targetUsername }).lean();
        if (dbUser) {
            socket.emit('user-profile-data', {
                username: dbUser.username, displayName: dbUser.displayName, avatar: dbUser.avatar,
                description: dbUser.description, pronouns: dbUser.pronouns,
                banner: dbUser.banner, customBackground: dbUser.customBackground, lastSeen: dbUser.lastSeen
            });
        } else {
            socket.emit('user-profile-data', { notFound: true, username: targetUsername });
        }
    });

    // PROFILE UPDATE
    socket.on('update-profile', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        try {
            await User.findOneAndUpdate({ username: user.username }, data, { upsert: true });
            
            // Update local cache
            if(data.displayName) user.displayName = data.displayName;
            if(data.avatar) {
                user.avatar = data.avatar;
                userAvatarCache[user.username] = data.avatar;
            }

            io.emit('user-status-change', { username: user.username, displayName: user.displayName, online: true, avatar: user.avatar });
            socket.emit('chat-message', formatMessage('System', 'Profile updated.'));
        } catch(e) { console.error(e); }
    });

    // --- MESSAGING ---
    socket.on('chat-message', async (payload) => {
        const user = users[socket.id];
        if (!user) return; // Ignore if not logged in

        let text = '', image = null, replyTo = null, target = null;

        // Parse Payload
        if (typeof payload === 'string') text = payload;
        else {
            text = payload.text;
            image = payload.image;
            replyTo = payload.replyTo;
            target = payload.target; // <--- VITAL FOR DMs
        }

        // 1. Handle Slash Commands (/msg, /ban, etc)
        if (text.startsWith('/')) {
            const parts = text.slice(1).split(' ');
            const cmd = parts[0].toLowerCase();
            const args = parts.slice(1);

            if (cmd === 'msg') {
                target = args[0];
                text = args.slice(1).join(' ');
            }
            // Add other admin commands here if needed...
        }

        // 2. Handle Routing
        if (target) {
            // PRIVATE MESSAGE
            const targetSocketId = findSocketIdByUsername(target);
            const pmMsg = formatMessage(user.username, text, user.avatar, image, true, replyTo, user.displayName);
            
            socket.emit('chat-message', pmMsg); // Send to sender
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat-message', pmMsg); // Send to receiver
            } else {
                socket.emit('chat-message', formatMessage('System', `User ${target} is not online.`));
            }
        } else {
            // PUBLIC MESSAGE
            const publicMsg = formatMessage(user.username, text, user.avatar, image, false, replyTo, user.displayName);
            io.emit('chat-message', publicMsg);
            addToHistory(publicMsg);
            savePublicMessage(publicMsg);
        }
    });

    // --- MESSAGE ACTIONS (DELETE / EDIT) ---
    socket.on('delete-message', async (msgId) => {
        // Find in history
        const index = messageHistory.findIndex(m => m.id === msgId);
        if (index !== -1) {
            // Check ownership (simple check: sender username matches)
            if (messageHistory[index].sender === users[socket.id].username) {
                messageHistory.splice(index, 1);
                await Message.deleteOne({ id: msgId });
                io.emit('message-deleted', msgId);
            }
        }
    });

    socket.on('edit-message', async ({ id, newText }) => {
        const msg = messageHistory.find(m => m.id === id);
        if (msg && msg.sender === users[socket.id].username) {
            msg.text = newText;
            msg.isEdited = true;
            await Message.updateOne({ id }, { text: newText, isEdited: true });
            io.emit('message-edited', { id, text: newText });
        }
    });

    // --- VOICE CHAT SIGNALING ---
    socket.on('join-vc', () => {
        const u = users[socket.id];
        if (u) {
            vcUsers[socket.id] = { id: socket.id, username: u.username, displayName: u.displayName, avatar: u.avatar };
            io.emit('vc-user-list-update', Object.values(vcUsers));
            socket.broadcast.emit('vc-user-joined', socket.id);
        }
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list-update', Object.values(vcUsers));
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });

    socket.on('disconnect', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list-update', Object.values(vcUsers));
            socket.broadcast.emit('vc-user-left', socket.id);
        }
        delete users[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
