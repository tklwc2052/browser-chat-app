const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose'); 

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set('trust proxy', 1); 

// --- DATABASE CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost/chatapp';

mongoose.connect(mongoURI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.log('❌ MongoDB Error:', err));

// --- Mongoose Schemas ---
const msgSchema = new mongoose.Schema({
    text: String,
    sender: String,
    avatar: String,
    image: String,
    time: String,
    type: String,
    target: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', msgSchema);

const banSchema = new mongoose.Schema({
    ip: String,
    username: String,
    reason: String,
    bannedAt: { type: Date, default: Date.now }
});
const Ban = mongoose.model('Ban', banSchema);

// [NEW] Whiteboard Schema
const whiteboardSchema = new mongoose.Schema({
    _id: { type: String, default: 'main_board' },
    lines: { type: Array, default: [] } 
});
const Whiteboard = mongoose.model('Whiteboard', whiteboardSchema);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
let messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const bannedHistory = {};     
const ADMIN_USERNAME = 'kl_'; 

// --- INITIAL DATA LOAD ---
async function loadData() {
    try {
        const savedBans = await Ban.find({});
        savedBans.forEach(b => {
            bannedIPs.set(b.ip, b.username);
            bannedHistory[b.username.toLowerCase()] = b.ip;
        });

        const savedMsgs = await Message.find({ type: { $ne: 'private' } }) 
            .sort({ timestamp: -1 })
            .limit(MAX_HISTORY);
        
        messageHistory = savedMsgs.reverse().map(m => ({
            text: m.text, sender: m.sender, avatar: m.avatar, image: m.image, time: m.time, type: m.type
        }));
    } catch (err) { console.error("Error loading data:", err); }
}
loadData();

// --- Utility Functions ---
function formatMessage(sender, text, avatar = null, image = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let finalAvatar = avatar || userAvatarCache[sender] || 'placeholder-avatar.png';
    return { text, image, sender, avatar: finalAvatar, time, type: 'general' };
}

function broadcastUserList() { io.emit('user-list-update', Object.values(users)); }
function broadcastVCUserList() { io.emit('vc-user-list-update', Object.values(vcUsers)); }

function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
    const newMsg = new Message({
        text: msgObj.text, sender: msgObj.sender, avatar: msgObj.avatar, image: msgObj.image, time: msgObj.time, type: msgObj.type
    });
    newMsg.save().catch(err => console.error("Save Msg Error:", err));
}

function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;
}

app.use(express.static('public'));

io.on('connection', async (socket) => {
    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    // Send Histories
    socket.emit('history', messageHistory);
    
    // [NEW] Send Whiteboard History
    try {
        let board = await Whiteboard.findById('main_board');
        if (!board) board = await Whiteboard.create({ _id: 'main_board' });
        socket.emit('wb-history', board.lines);
    } catch (e) { console.log(e); }

    broadcastUserList();
    broadcastVCUserList(); 

    // --- WHITEBOARD EVENTS ---
    socket.on('wb-draw', async (data) => {
        socket.broadcast.emit('wb-draw', data);
        await Whiteboard.findByIdAndUpdate('main_board', { $push: { lines: data } }, { upsert: true });
    });

    socket.on('wb-clear', async () => {
        await Whiteboard.findByIdAndUpdate('main_board', { lines: [] });
        io.emit('wb-redraw-all', []);
    });

    // --- CHAT EVENTS ---
    socket.on('set-username', ({ username, avatar }) => {
        if (!username) return;
        userAvatarCache[username] = avatar || 'placeholder-avatar.png';
        users[socket.id] = { username, avatar: avatar || 'placeholder-avatar.png', id: socket.id };
        
        io.emit('chat-message', formatMessage('System', `User '${username}' joined.`));
        broadcastUserList();
    });

    socket.on('chat-message', (payload) => {
        const userData = users[socket.id];
        if (!userData) return;
        if (mutedUsers.has(userData.username.toLowerCase())) return;

        let msgText = typeof payload === 'string' ? payload : payload.text || '';
        let msgImage = typeof payload === 'object' ? payload.image : null;

        // Admin Commands
        if (msgText.startsWith('/') && userData.username === ADMIN_USERNAME) {
             const parts = msgText.split(' ');
             const cmd = parts[0];
             const target = parts[1];
             if (cmd === '/clear') {
                 messageHistory = [];
                 Message.deleteMany({}).exec();
                 io.emit('history', []); // Clear client side
                 return;
             }
             if (cmd === '/ban' && target) {
                 const targetId = Object.keys(users).find(id => users[id].username === target);
                 if (targetId) {
                     const ip = getClientIp(io.sockets.sockets.get(targetId));
                     bannedIPs.set(ip, target);
                     new Ban({ ip, username: target, reason: "Admin Ban" }).save();
                     io.to(targetId).emit('chat-message', formatMessage('System', 'You have been banned.'));
                     io.sockets.sockets.get(targetId).disconnect();
                 }
                 return;
             }
        }

        const msgObj = formatMessage(userData.username, msgText, userData.avatar, msgImage);
        io.emit('chat-message', msgObj);
        addToHistory(msgObj);
    });

    socket.on('vc-join', () => { 
        if(users[socket.id]) { vcUsers[socket.id] = {...users[socket.id], isMuted: false}; broadcastVCUserList(); }
    });
    socket.on('vc-leave', () => { 
        if(vcUsers[socket.id]) { delete vcUsers[socket.id]; broadcastVCUserList(); }
    });
    socket.on('typing-start', () => socket.broadcast.emit('user-typing', users[socket.id]?.username));
    socket.on('typing-stop', () => socket.broadcast.emit('user-stopped-typing', users[socket.id]?.username));

    socket.on('disconnect', () => {
        delete users[socket.id];
        delete vcUsers[socket.id];
        broadcastUserList();
        broadcastVCUserList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
