const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- RENDER SPECIFIC FIX ---
app.set('trust proxy', 1);

// --- IMPORTANT: SERVE STATIC FILES ---
// This was missing! It tells the server to use index.html and styles.css
app.use(express.static(__dirname));

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

// --- WHITEBOARD SCHEMA ---
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

// --- Admin State ---
const ADMIN_USERNAME = "kl_"; 

// --- HELPER FUNCTIONS ---
function formatMessage(username, text, avatar = null, image = null, type = 'chat', target = null) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { sender: username, text, time, avatar, image, type, target };
}

async function addToHistory(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

    try {
        const newMsg = new Message(msg);
        await newMsg.save();
    } catch (err) {
        console.error("DB Save Error:", err);
    }
}

function broadcastUserList() {
    io.emit('room-users', { users: Object.values(users) });
}

function broadcastVCUserList() {
    io.emit('vc-user-list', Object.values(vcUsers));
}

// --- SOCKET LOGIC ---
io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // Check Ban Status
    const isBanned = await Ban.findOne({ ip: clientIp });
    if (isBanned) {
        socket.emit('banned', `You are banned: ${isBanned.reason}`);
        socket.disconnect();
        return;
    }

    // 1. Send Data to New User
    socket.emit('update-user-list', Object.values(users));
    broadcastVCUserList();
    socket.emit('history', messageHistory);

    // 2. Send Whiteboard History (From DB)
    try {
        let board = await Whiteboard.findById('main_board');
        if (!board) board = await Whiteboard.create({ _id: 'main_board' });
        socket.emit('wb-history', board.lines);
    } catch (err) {
        console.error("WB Load Error:", err);
    }

    // --- WHITEBOARD EVENTS ---
    socket.on('wb-draw', async (data) => {
        socket.broadcast.emit('wb-draw', data);
        await Whiteboard.findByIdAndUpdate('main_board', { 
            $push: { lines: data } 
        }, { upsert: true });
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

    // --- CHAT & USER EVENTS ---
    socket.on('join', (username) => {
        if (!username || username.trim() === "") return;
        
        users[socket.id] = { 
            id: socket.id, 
            username: username, 
            avatar: 'default',
            isAdmin: username === ADMIN_USERNAME,
            ip: clientIp 
        };

        const joinMsg = formatMessage('System', `**${username}** joined the chat.`);
        io.emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        broadcastUserList();
    });

    socket.on('chat-message', async (msg) => {
        const user = users[socket.id];
        if (!user) return;

        // Admin Commands
        if (msg.startsWith('/')) {
            const parts = msg.split(' ');
            const cmd = parts[0];
            const targetName = parts[1];
            
            if (user.isAdmin) {
                if (cmd === '/clear') {
                    messageHistory = [];
                    await Message.deleteMany({});
                    io.emit('clear-history');
                    return;
                }
                if (cmd === '/kick' && targetName) {
                    const targetSocketId = Object.keys(users).find(id => users[id].username === targetName);
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('kicked', 'You have been kicked.');
                        io.sockets.sockets.get(targetSocketId)?.disconnect();
                    }
                    return;
                }
                if (cmd === '/ban' && targetName) {
                    const targetSocketId = Object.keys(users).find(id => users[id].username === targetName);
                    if (targetSocketId) {
                        const targetUser = users[targetSocketId];
                        await Ban.create({ ip: targetUser.ip, username: targetUser.username, reason: "Admin Ban" });
                        io.to(targetSocketId).emit('banned', 'You have been banned.');
                        io.sockets.sockets.get(targetSocketId)?.disconnect();
                    }
                    return;
                }
            }
        }

        const messageData = formatMessage(user.username, msg, user.avatar);
        io.emit('chat-message', messageData);
        addToHistory(messageData);
    });

    socket.on('set-avatar', (avatarData) => {
        if (users[socket.id]) {
            users[socket.id].avatar = avatarData;
            broadcastUserList();
        }
    });

    // --- VOICE CHAT EVENTS ---
    socket.on('vc-join', () => {
        if (users[socket.id]) {
            vcUsers[socket.id] = { ...users[socket.id], isMuted: false };
            broadcastVCUserList();
            socket.emit('vc-existing-users', Object.keys(vcUsers).filter(id => id !== socket.id));
        }
    });

    socket.on('vc-leave', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            broadcastVCUserList();
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });

    socket.on('signal', (data) => io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal }));
    
    socket.on('typing-start', () => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('user-typing', user.username);
    });

    socket.on('typing-stop', () => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('user-stopped-typing', user.username);
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            delete users[socket.id];
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id);
            }
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
