const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- RENDER SPECIFIC FIX ---
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

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
let messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 
let whiteboardHistory = [];

// --- Admin State ---
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = "kl_"; 

// --- Helper Functions ---
function formatMessage(username, text, type = 'text', avatar = '', image = '') {
    return {
        username,
        text,
        type,
        avatar,
        image,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
}

async function addToHistory(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    try {
        const newMsg = new Message({
            text: msg.text,
            sender: msg.username,
            avatar: msg.avatar,
            image: msg.image,
            time: msg.time,
            type: msg.type
        });
        await newMsg.save();
    } catch (err) { console.error("Error saving message:", err); }
}

async function loadBansAndHistory() {
    try {
        const bans = await Ban.find({});
        bans.forEach(b => bannedIPs.set(b.ip, b.reason));
        const oldMsgs = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY);
        messageHistory = oldMsgs.reverse().map(m => ({
            username: m.sender,
            text: m.text,
            avatar: m.avatar,
            image: m.image,
            time: m.time,
            type: m.type
        }));
    } catch (err) { console.error("Error loading data:", err); }
}
loadBansAndHistory();

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;

    if (bannedIPs.has(clientIp)) {
        socket.emit('banned', bannedIPs.get(clientIp));
        socket.disconnect();
        return;
    }

    socket.emit('history', messageHistory);
    socket.emit('whiteboard-history', whiteboardHistory);
    
    const broadcastUserList = () => {
        const userList = Object.values(users).map(u => ({ 
            id: u.id, username: u.username, avatar: u.avatar, isAdmin: u.username === ADMIN_USERNAME
        }));
        io.emit('update-user-list', userList);
    };

    const broadcastVCUserList = () => {
        io.emit('vc-update-users', Object.values(vcUsers));
    };

    broadcastUserList();
    broadcastVCUserList();

    socket.on('set-username', (data) => {
        const username = data.username.trim().substring(0, 20) || 'Anonymous';
        const avatar = data.avatar || 'placeholder-avatar.png';
        users[socket.id] = { id: socket.id, username, avatar, ip: clientIp };
        userAvatarCache[username] = avatar;
        io.emit('chat-message', formatMessage('System', `**${username}** joined the chat.`));
        broadcastUserList();
    });

    socket.on('chat-message', (msgData) => {
        const user = users[socket.id];
        if (!user) return;
        if (mutedUsers.has(clientIp)) {
            socket.emit('system-message', 'You are muted.');
            return;
        }

        const text = msgData.text;
        if (text.startsWith('/') && user.username === ADMIN_USERNAME) {
            const args = text.split(' ');
            const command = args[0];
            const targetName = args[1];

            if (command === '/clear') {
                messageHistory = [];
                io.emit('clear-chat');
                return;
            }
            if (targetName) {
                const targetId = Object.keys(users).find(id => users[id].username === targetName);
                if (targetId) {
                    const targetIp = users[targetId].ip;
                    if (command === '/kick') {
                        io.to(targetId).emit('kick');
                        io.sockets.sockets.get(targetId)?.disconnect();
                        io.emit('chat-message', formatMessage('System', `**${targetName}** was kicked.`));
                    } else if (command === '/ban') {
                        bannedIPs.set(targetIp, "Banned by Admin");
                        new Ban({ ip: targetIp, username: targetName, reason: "Banned by Admin" }).save();
                        io.to(targetId).emit('banned', "Banned by Admin");
                        io.sockets.sockets.get(targetId)?.disconnect();
                        io.emit('chat-message', formatMessage('System', `**${targetName}** was banned.`));
                    } else if (command === '/mute') {
                        mutedUsers.add(targetIp);
                        io.emit('chat-message', formatMessage('System', `**${targetName}** was muted.`));
                    }
                }
            }
            return;
        }

        const newMsg = formatMessage(user.username, text, msgData.image ? 'image' : 'text', user.avatar, msgData.image);
        io.emit('chat-message', newMsg);
        addToHistory(newMsg);
    });

    socket.on('drawing', (data) => {
        whiteboardHistory.push(data);
        if(whiteboardHistory.length > 2000) whiteboardHistory.shift();
        socket.broadcast.emit('drawing', data);
    });

    socket.on('clear-board', () => {
        whiteboardHistory = [];
        io.emit('clear-board');
    });

    socket.on('vc-join', () => {
        const user = users[socket.id];
        if (user) {
            vcUsers[socket.id] = { id: socket.id, username: user.username, avatar: user.avatar, isMuted: false };
            io.emit('chat-message', formatMessage('System', `**${user.username}** joined Voice Chat.`));
            broadcastVCUserList();
        }
    });

    socket.on('vc-leave', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            broadcastVCUserList();
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
        if (users[socket.id]) socket.broadcast.emit('user-typing', users[socket.id].username);
    });
    socket.on('typing-stop', () => {
        if (users[socket.id]) socket.broadcast.emit('user-stopped-typing', users[socket.id].username);
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) delete users[socket.id];
        if (vcUsers[socket.id]) delete vcUsers[socket.id];
        broadcastUserList();
        broadcastVCUserList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
