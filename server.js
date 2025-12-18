const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); // Added this to help with file paths

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- RENDER SPECIFIC FIX ---
app.set('trust proxy', 1);

// --- SERVE STATIC FILES (CSS, JS, IMAGES) ---
app.use(express.static(__dirname));

// --- THE FIX: EXPLICIT ROOT ROUTE ---
// This forces the server to send index.html when you visit the site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- DATABASE CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost/chatapp';

mongoose.connect(mongoURI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.log('❌ MongoDB Error:', err));

// --- SCHEMAS ---
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

const whiteboardSchema = new mongoose.Schema({
    _id: { type: String, default: 'main_board' },
    lines: { type: Array, default: [] } 
});
const Whiteboard = mongoose.model('Whiteboard', whiteboardSchema);

// --- STATE ---
const users = {};
const vcUsers = {};
let messageHistory = []; 
const MAX_HISTORY = 50;
const ADMIN_USERNAME = "kl_"; 

// --- HELPERS ---
function formatMessage(username, text, avatar = null, image = null, type = 'chat', target = null) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { sender: username, text, time, avatar, image, type, target };
}

async function addToHistory(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    try {
        await new Message(msg).save();
    } catch (err) { console.error("DB Save Error:", err); }
}

function broadcastUserList() { io.emit('room-users', { users: Object.values(users) }); }
function broadcastVCUserList() { io.emit('vc-user-list', Object.values(vcUsers)); }

// --- SOCKET LOGIC ---
io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // Check Ban
    const isBanned = await Ban.findOne({ ip: clientIp });
    if (isBanned) {
        socket.emit('banned', `You are banned: ${isBanned.reason}`);
        socket.disconnect();
        return;
    }

    // Init Data
    socket.emit('update-user-list', Object.values(users));
    broadcastVCUserList();
    socket.emit('history', messageHistory);

    // Load Whiteboard
    try {
        let board = await Whiteboard.findById('main_board');
        if (!board) board = await Whiteboard.create({ _id: 'main_board' });
        socket.emit('wb-history', board.lines);
    } catch (err) { console.error("WB Load Error:", err); }

    // Whiteboard Events
    socket.on('wb-draw', async (data) => {
        socket.broadcast.emit('wb-draw', data);
        await Whiteboard.findByIdAndUpdate('main_board', { $push: { lines: data } }, { upsert: true });
    });

    socket.on('wb-undo', async () => {
        const board = await Whiteboard.findById('main_board');
        if (board && board.lines.length > 0) {
            board.lines.pop(); 
            await board.save();
            io.emit('wb-redraw-all', board.lines); 
        }
    });

    socket.on('wb-clear', async () => {
        await Whiteboard.findByIdAndUpdate('main_board', { lines: [] });
        io.emit('wb-redraw-all', []);
    });

    // Chat Events
    socket.on('join', (username) => {
        if (!username || username.trim() === "") return;
        users[socket.id] = { id: socket.id, username, avatar: 'default', isAdmin: username === ADMIN_USERNAME, ip: clientIp };
        const joinMsg = formatMessage('System', `**${username}** joined.`);
        io.emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        broadcastUserList();
    });

    socket.on('chat-message', async (msg) => {
        const user = users[socket.id];
        if (!user) return;

        // Admin
        if (msg.startsWith('/') && user.isAdmin) {
            const parts = msg.split(' ');
            if (parts[0] === '/clear') {
                messageHistory = [];
                await Message.deleteMany({});
                io.emit('clear-history');
                return;
            }
            if (parts[0] === '/kick' && parts[1]) {
                const targetId = Object.keys(users).find(id => users[id].username === parts[1]);
                if (targetId) { io.to(targetId).emit('kicked'); io.sockets.sockets.get(targetId)?.disconnect(); }
                return;
            }
            if (parts[0] === '/ban' && parts[1]) {
                const targetId = Object.keys(users).find(id => users[id].username === parts[1]);
                if (targetId) {
                    await Ban.create({ ip: users[targetId].ip, username: users[targetId].username, reason: "Admin Ban" });
                    io.to(targetId).emit('banned'); io.sockets.sockets.get(targetId)?.disconnect();
                }
                return;
            }
        }

        const messageData = formatMessage(user.username, msg, user.avatar);
        io.emit('chat-message', messageData);
        addToHistory(messageData);
    });

    socket.on('set-avatar', (data) => { if(users[socket.id]) { users[socket.id].avatar = data; broadcastUserList(); }});
    
    // VC Events
    socket.on('vc-join', () => { 
        if(users[socket.id]) { vcUsers[socket.id] = {...users[socket.id], isMuted: false}; broadcastVCUserList(); socket.emit('vc-existing-users', Object.keys(vcUsers).filter(id => id !== socket.id)); }
    });
    socket.on('vc-leave', () => { if(vcUsers[socket.id]) { delete vcUsers[socket.id]; broadcastVCUserList(); socket.broadcast.emit('vc-user-left', socket.id); }});
    socket.on('vc-mute-toggle', (m) => { if(vcUsers[socket.id]) { vcUsers[socket.id].isMuted = m; broadcastVCUserList(); }});
    socket.on('signal', (d) => io.to(d.target).emit('signal', { sender: socket.id, signal: d.signal }));
    
    socket.on('typing-start', () => { if(users[socket.id]) socket.broadcast.emit('user-typing', users[socket.id].username); });
    socket.on('typing-stop', () => { if(users[socket.id]) socket.broadcast.emit('user-stopped-typing', users[socket.id].username); });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            delete users[socket.id];
            if (vcUsers[socket.id]) { delete vcUsers[socket.id]; broadcastVCUserList(); socket.broadcast.emit('vc-user-left', socket.id); }
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
