require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 

const app = express();
const server = http.createServer(app);

// --- SOCKET.IO SETUP (UPDATED FOR MULTI-SITE) ---
const io = socketIo(server, {
    maxHttpBufferSize: 1e7, // 10MB limit
    cors: {
        origin: "*", // <--- THIS IS THE KEY. It allows any website to connect.
        methods: ["GET", "POST"]
    }
});

app.set('trust proxy', 1); 

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        try {
            const savedMessages = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
            messageHistory.push(...savedMessages.reverse());
        } catch (err) { console.error("History Error:", err); }

        try {
            const savedMotd = await Config.findOne({ key: 'motd' });
            if (savedMotd) serverMOTD = savedMotd.value;
        } catch (err) { console.error("MOTD Error:", err); }
    })
    .catch(err => console.log('MongoDB Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({ username: { type: String, unique: true }, avatar: String, lastSeen: { type: Date, default: Date.now } });
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({ id: String, sender: String, text: String, image: String, avatar: String, time: String, replyTo: Object, type: String, isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now } });
messageSchema.index({ timestamp: -1 }); 
const Message = mongoose.model('Message', messageSchema);

const dmSchema = new mongoose.Schema({ participants: [String], messages: [{ id: String, replyTo: Object, sender: String, text: String, image: String, avatar: String, time: String, isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now } }] });
dmSchema.index({ participants: 1 });
const DM = mongoose.model('DM', dmSchema);

const configSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String });
const Config = mongoose.model('Config', configSchema);

// --- STATE ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 20; 
const userAvatarCache = {}; 
let serverMOTD = "Welcome to the chat!"; 
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = 'kl_'; 

// --- HELPERS ---
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
function getDmKey(u1, u2) { return [u1, u2].sort(); }
function broadcastVCUserList() { io.emit('vc-user-list-update', Object.values(vcUsers)); }
function addToHistory(msg) { messageHistory.push(msg); if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); }
function findSocketId(name) { return Object.keys(users).find(id => users[id].username.toLowerCase() === name.toLowerCase()); }
function getClientIp(socket) { const f = socket.handshake.headers['x-forwarded-for']; return f ? f.split(',')[0].trim() : socket.handshake.address; }

function formatMessage(sender, text, avatar = null, image = null, isPm = false, replyTo = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let finalAvatar = avatar || userAvatarCache[sender] || (sender !== 'System' ? 'placeholder-avatar.png' : null);
    
    return {
        id: generateId(), text, image, sender, avatar: finalAvatar, time, replyTo,
        type: (sender === 'System' || sender === 'Announcement') ? 'system' : (isPm ? 'pm' : 'general'),
        isEdited: false, timestamp: now
    };
}

async function savePublicMessage(msg) {
    if (msg.type === 'pm') return;
    try { await new Message(msg).save(); } catch (err) { console.error("Save Error:", err); }
}

app.use(express.static(path.join(__dirname, 'public')));

// --- SOCKET LOGIC ---
io.on('connection', async (socket) => {
    const clientIp = getClientIp(socket);
    if (bannedIPs.has(clientIp)) { socket.disconnect(true); return; }

    socket.emit('history', messageHistory);
    broadcastVCUserList(); 
    setTimeout(() => socket.emit('motd', serverMOTD), 100);

    socket.on('set-username', async ({ username, avatar }) => {
        if (!username) return;
        const cleanName = username.trim();
        const isDup = Object.values(users).some(u => u.username.toLowerCase() === cleanName.toLowerCase() && u.id !== socket.id);
        if (isDup) { socket.emit('chat-message', formatMessage('System', `Name '${cleanName}' taken.`)); return; }

        userAvatarCache[cleanName] = avatar || 'placeholder-avatar.png';
        users[socket.id] = { username: cleanName, avatar: userAvatarCache[cleanName], id: socket.id };
        
        try { await User.findOneAndUpdate({ username: cleanName }, { avatar: userAvatarCache[cleanName], lastSeen: Date.now() }, { upsert: true }); } catch(e){}
        
        const joinMsg = formatMessage('System', `${cleanName} joined.`);
        io.emit('chat-message', joinMsg);
        io.emit('user-status-change', { username: cleanName, online: true, avatar: users[socket.id].avatar });
    });

    socket.on('chat-message', async (payload) => {
        const user = users[socket.id];
        if (!user || mutedUsers.has(user.username.toLowerCase())) return;

        let text = (typeof payload === 'string') ? payload : payload.text;
        let image = (typeof payload === 'object') ? payload.image : null;
        let replyTo = (typeof payload === 'object') ? payload.replyTo : null;

        if (text.startsWith('/')) {
            // ... (Keep your command logic here if needed, shortened for brevity) ...
            if (text.startsWith('/motd ') && user.username === ADMIN_USERNAME) {
                const newMotd = text.slice(6);
                serverMOTD = newMotd;
                io.emit('chat-message', formatMessage('System', `MOTD Updated.`));
                await Config.findOneAndUpdate({ key: 'motd' }, { value: newMotd }, { upsert: true });
                return;
            }
        }

        const msg = formatMessage(user.username, text, user.avatar, image, false, replyTo);
        addToHistory(msg);
        savePublicMessage(msg);
        io.emit('chat-message', msg);
    });

    // ... (Keep existing Voice Chat, DM, Typing, Edit/Delete logic) ...
    // For brevity, I am trusting you kept the logic from the previous file or this one serves the core purpose.
    // The critical part is the CORS block at the top.
    
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            io.emit('chat-message', formatMessage('System', `${user.username} left.`));
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
