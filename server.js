require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Increase buffer for image uploads (10MB)
const io = socketIo(server, {
    maxHttpBufferSize: 1e7
});

app.set('trust proxy', 1); // Important for Render

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'admin123';

mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        loadHistoryAndMotd();
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---
const messageSchema = new mongoose.Schema({
    username: String,
    text: String,
    avatar: String,
    timestamp: { type: Date, default: Date.now },
    isSystem: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', messageSchema);

const configSchema = new mongoose.Schema({
    key: String,
    value: String
});
const Config = mongoose.model('Config', configSchema);

// --- GLOBAL VARIABLES ---
let messageHistory = [];
const MAX_HISTORY = 50;
let users = {}; 
let vcUsers = {}; 
let serverMOTD = "Welcome to the chat!";
const bannedIPs = new Map(); 

// --- HELPER FUNCTIONS ---
async function loadHistoryAndMotd() {
    try {
        const savedMessages = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
        messageHistory = savedMessages.reverse();
        
        const savedMotd = await Config.findOne({ key: 'motd' });
        if (savedMotd) serverMOTD = savedMotd.value;
    } catch (err) {
        console.error("Error loading data:", err);
    }
}

function formatMessage(username, text, avatar = null, isSystem = false) {
    return { username, text, avatar, timestamp: new Date(), isSystem };
}

async function savePublicMessage(msgObj) {
    try {
        await new Message(msgObj).save();
    } catch (err) {
        console.error("Error saving message:", err);
    }
}

// --- SERVE STATIC FILES ---
app.use(express.static(path.join(__dirname, 'public')));

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    if (bannedIPs.has(clientIp)) {
        socket.emit('disconnect-reason', `You are banned. Reason: ${bannedIPs.get(clientIp)}`);
        socket.disconnect();
        return;
    }

    users[socket.id] = {
        username: null,
        avatar: null,
        isMuted: false,
        isAdmin: false,
        ip: clientIp
    };

    socket.emit('chat-history', messageHistory);
    socket.emit('server-motd', serverMOTD);

    // --- EVENTS ---

    socket.on('set-username', (data) => {
        let cleanName = data.username.trim().substring(0, 20);
        const nameExists = Object.values(users).some(u => u.username && u.username.toLowerCase() === cleanName.toLowerCase());
        
        if (nameExists) cleanName += `_${Math.floor(Math.random() * 1000)}`;

        users[socket.id].username = cleanName;
        users[socket.id].avatar = data.avatar;

        const joinMsg = formatMessage('System', `${cleanName} joined.`, null, true);
        io.emit('chat-message', joinMsg);
        messageHistory.push(joinMsg);
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
        
        io.emit('user-status-change', { username: cleanName, online: true });
        io.emit('update-user-list', Object.values(users).filter(u => u.username).map(u => u.username));
    });

    socket.on('chat-message', async (msgData) => {
        const user = users[socket.id];
        if (!user || !user.username) return;
        if (user.isMuted) {
            socket.emit('error-message', "You are muted.");
            return;
        }

        const text = msgData.text.trim();
        if (!text) return;

        // COMMAND CHECK
        if (text.startsWith('/')) {
            await handleCommand(socket, text, user);
            return;
        }

        const newMsg = formatMessage(user.username, text, user.avatar);
        if (msgData.replyTo) newMsg.replyTo = msgData.replyTo;

        io.emit('chat-message', newMsg);
        messageHistory.push(newMsg);
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
        savePublicMessage(newMsg);
    });

    socket.on('image-upload', (data) => {
        const user = users[socket.id];
        if (!user || user.isMuted) return;

        const imgMsg = formatMessage(user.username, '', user.avatar);
        imgMsg.image = data.image;
        io.emit('chat-message', imgMsg);
        messageHistory.push(imgMsg);
        savePublicMessage(imgMsg);
    });

    // Voice Chat
    socket.on('vc-join', () => {
        if (!users[socket.id].username) return;
        vcUsers[socket.id] = { username: users[socket.id].username, isMuted: false };
        broadcastVCUserList();
        io.emit('chat-message', formatMessage('System', `${users[socket.id].username} joined VC.`, null, true));
    });

    socket.on('vc-leave', () => handleVCLeave(socket));
    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });
    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });

    // Disconnect
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user && user.username) {
            handleVCLeave(socket);
            const leaveMsg = formatMessage('System', `${user.username} left.`, null, true);
            io.emit('chat-message', leaveMsg);
            io.emit('user-status-change', { username: user.username, online: false });
            delete users[socket.id];
            io.emit('update-user-list', Object.values(users).filter(u => u.username).map(u => u.username));
        } else {
            delete users[socket.id];
        }
    });
});

// --- COMMAND HANDLER ---
async function handleCommand(socket, text, user) {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // 1. AUTH
    if (cmd === '/auth') {
        if (args[0] === ADMIN_PASSWORD) {
            users[socket.id].isAdmin = true;
            socket.emit('system-message', '✅ You are now an Admin.');
        } else {
            socket.emit('error-message', '❌ Incorrect Password.');
        }
        return;
    }

    // 2. CHECK PERMS
    if (!users[socket.id].isAdmin) {
        socket.emit('error-message', 'Unknown command or permission denied. Use /auth <password>');
        return;
    }

    const findTargetId = (name) => {
        if (!name) return null;
        return Object.keys(users).find(id => 
            users[id].username && users[id].username.toLowerCase() === name.toLowerCase()
        );
    };

    switch (cmd) {
        case '/kick':
            const kickTarget = findTargetId(args[0]);
            if (kickTarget) {
                io.to(kickTarget).emit('disconnect-reason', 'You have been KICKED by an admin.');
                io.sockets.sockets.get(kickTarget).disconnect();
                io.emit('chat-message', formatMessage('System', `🔨 ${args[0]} was kicked.`, null, true));
            } else {
                socket.emit('error-message', 'User not found.');
            }
            break;

        case '/ban':
            const banTarget = findTargetId(args[0]);
            if (banTarget) {
                bannedIPs.set(users[banTarget].ip, 'Banned by Admin');
                io.to(banTarget).emit('disconnect-reason', 'You have been BANNED.');
                io.sockets.sockets.get(banTarget).disconnect();
                io.emit('chat-message', formatMessage('System', `🚫 ${args[0]} was BANNED.`, null, true));
            } else {
                socket.emit('error-message', 'User not found.');
            }
            break;

        case '/mute':
            const muteTarget = findTargetId(args[0]);
            if (muteTarget) {
                users[muteTarget].isMuted = true;
                socket.emit('system-message', `Muted ${args[0]}.`);
                io.to(muteTarget).emit('error-message', 'You have been muted by an admin.');
            }
            break;

        case '/unmute':
            const unmuteTarget = findTargetId(args[0]);
            if (unmuteTarget) {
                users[unmuteTarget].isMuted = false;
                socket.emit('system-message', `Unmuted ${args[0]}.`);
                io.to(unmuteTarget).emit('system-message', 'You have been unmuted.');
            }
            break;
        
        case '/motd':
            serverMOTD = args.join(' ');
            await Config.findOneAndUpdate({ key: 'motd' }, { value: serverMOTD }, { upsert: true });
            io.emit('server-motd', serverMOTD);
            io.emit('chat-message', formatMessage('System', `MOTD updated: ${serverMOTD}`, null, true));
            break;

        case '/announce':
            io.emit('announcement', args.join(' '));
            break;

        // --- UPDATED COMMAND: /clear (Formerly Prune) ---
        case '/clear':
            const count = args[0];
            try {
                if (count === 'all') {
                    // Clear EVERYTHING
                    await Message.deleteMany({});
                    messageHistory = [];
                    io.emit('chat-history-reload', messageHistory);
                    io.emit('chat-message', formatMessage('System', '⚠️ Chat history fully WIPED.', null, true));
                } else {
                    // Clear Number
                    const num = parseInt(count);
                    if (!isNaN(num) && num > 0) {
                        const allMsgs = await Message.find().sort({ timestamp: -1 }).limit(num);
                        const ids = allMsgs.map(m => m._id);
                        await Message.deleteMany({ _id: { $in: ids } });
                        
                        // Reload
                        messageHistory = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
                        messageHistory.reverse();
                        io.emit('chat-history-reload', messageHistory);
                        io.emit('chat-message', formatMessage('System', `🧹 Cleared last ${num} messages.`, null, true));
                    } else {
                        socket.emit('error-message', 'Usage: /clear <number> or /clear all');
                    }
                }
            } catch (err) {
                console.error(err);
                socket.emit('error-message', 'Database error.');
            }
            break;

        // --- UPDATED COMMAND: /prune (Clears User List) ---
        case '/prune':
            let kickedCount = 0;
            // Iterate all sockets
            io.sockets.sockets.forEach((s) => {
                // Don't kick the admin who ran the command
                if (s.id !== socket.id) {
                    s.emit('disconnect-reason', 'Server performed a user list prune.');
                    s.disconnect(true);
                    kickedCount++;
                }
            });
            socket.emit('system-message', `✂️ Pruned ${kickedCount} users. List cleared.`);
            // User list will auto-update via the disconnect events
            break;

        default:
            socket.emit('error-message', 'Invalid Admin Command.');
    }
}

function broadcastVCUserList() {
    io.emit('vc-user-list', Object.values(vcUsers));
}

function handleVCLeave(socket) {
    if (vcUsers[socket.id]) {
        const u = vcUsers[socket.id];
        delete vcUsers[socket.id];
        broadcastVCUserList();
        socket.broadcast.emit('vc-user-left', socket.id);
        io.emit('chat-message', formatMessage('System', `${u.username} left Voice Chat.`, null, true));
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
