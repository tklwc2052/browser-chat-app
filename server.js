require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- 1. CONNECT TO MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- 2. SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    avatar: String,
    lastSeen: { type: Date, default: Date.now },
    isMuted: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    ip: String // To track IP bans
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    text: String,
    image: String,
    sender: String,
    avatar: String,
    type: { type: String, default: 'general' },
    target: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// --- SERVER SETUP ---
app.use(express.static('public')); // Corrected folder path
app.set('trust proxy', 1); 

// --- ADMIN CONFIG ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const adminSockets = new Set(); // Track which sockets are logged in as admin

// Helper: Format message
function formatMsg(dbMsg) {
    return {
        text: dbMsg.text,
        image: dbMsg.image,
        sender: dbMsg.sender,
        avatar: dbMsg.avatar,
        time: new Date(dbMsg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        type: dbMsg.type,
        target: dbMsg.target
    };
}

const onlineUsers = new Map(); // socket.id -> username

io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // CHECK IP BAN
    const bannedUser = await User.findOne({ ip: clientIp, isBanned: true });
    if (bannedUser) {
        socket.disconnect();
        return;
    }

    // --- ON JOIN ---
    socket.on('set-username', async (data) => {
        const { username, avatar } = data;
        const cleanName = username.trim();

        // Check DB for Ban/Mute
        let user = await User.findOne({ username: cleanName });
        if (user && user.isBanned) {
            socket.emit('chat-message', { sender: 'System', text: 'You are banned.', type: 'system' });
            socket.disconnect();
            return;
        }

        if (!user) {
            user = await User.create({ username: cleanName, avatar, ip: clientIp });
        } else {
            user.avatar = avatar; 
            user.lastSeen = new Date();
            user.ip = clientIp; // Update IP
            await user.save();
        }

        onlineUsers.set(socket.id, cleanName);

        // 1. Send Global History
        const globalMsgs = await Message.find({ type: { $in: ['general', 'system'] } })
            .sort({ timestamp: -1 }).limit(50);
        socket.emit('history', globalMsgs.reverse().map(formatMsg));

        // 2. Send DM History
        const myDms = await Message.find({
            type: 'private',
            $or: [{ target: cleanName }, { sender: cleanName }]
        }).sort({ timestamp: 1 });
        
        const dmHistory = {};
        myDms.forEach(msg => {
            const otherPerson = (msg.sender === cleanName) ? msg.target : msg.sender;
            const key = [cleanName, otherPerson].sort().join(':');
            if (!dmHistory[key]) dmHistory[key] = [];
            dmHistory[key].push(formatMsg(msg));
        });
        socket.emit('dm-history-sync', dmHistory);

        // 3. Send User List
        const allUsers = await User.find({}).sort({ lastSeen: -1 });
        io.emit('user-list-update', allUsers);
        
        io.emit('status-update', { username: cleanName, status: 'online' });
    });

    // --- ON MESSAGE ---
    socket.on('chat-message', async (payload) => {
        const senderName = onlineUsers.get(socket.id);
        if (!senderName) return;

        const user = await User.findOne({ username: senderName });
        if (user && user.isMuted) {
            socket.emit('chat-message', { sender: 'System', text: 'You are muted.', type: 'system' });
            return;
        }

        // --- ADMIN COMMANDS ---
        if (payload.text && payload.text.startsWith('/')) {
            const args = payload.text.slice(1).split(' ');
            const command = args.shift().toLowerCase();

            // /auth password
            if (command === 'auth') {
                if (args[0] === ADMIN_PASSWORD) {
                    adminSockets.add(socket.id);
                    socket.emit('chat-message', { sender: 'System', text: 'Admin logged in.', type: 'system' });
                }
                return;
            }

            // Admin checks
            if (['kick', 'ban', 'mute', 'unmute'].includes(command)) {
                if (!adminSockets.has(socket.id)) {
                    socket.emit('chat-message', { sender: 'System', text: 'Permission denied.', type: 'system' });
                    return;
                }
                
                const targetName = args[0];
                const targetUser = await User.findOne({ username: targetName });

                if (!targetUser) {
                    socket.emit('chat-message', { sender: 'System', text: 'User not found.', type: 'system' });
                    return;
                }

                if (command === 'mute') {
                    targetUser.isMuted = true;
                    await targetUser.save();
                    io.emit('chat-message', { sender: 'System', text: `**${targetName}** was muted.`, type: 'system' });
                }
                if (command === 'unmute') {
                    targetUser.isMuted = false;
                    await targetUser.save();
                    io.emit('chat-message', { sender: 'System', text: `**${targetName}** was unmuted.`, type: 'system' });
                }
                if (command === 'ban') {
                    targetUser.isBanned = true;
                    await targetUser.save();
                    // Disconnect if online
                    for (let [id, name] of onlineUsers.entries()) {
                        if (name === targetName) {
                            io.to(id).emit('chat-message', { sender: 'System', text: 'You have been banned.', type: 'system' });
                            io.sockets.sockets.get(id)?.disconnect();
                        }
                    }
                    io.emit('chat-message', { sender: 'System', text: `**${targetName}** was BANNED.`, type: 'system' });
                }
                return;
            }
        }

        // --- NORMAL MESSAGE ---
        const newMsg = await Message.create({
            text: payload.text,
            image: payload.image,
            sender: senderName,
            avatar: payload.avatar,
            type: payload.type || 'general',
            target: payload.target
        });

        const formatted = formatMsg(newMsg);

        if (payload.type === 'private' && payload.target) {
            socket.emit('chat-message', formatted); // Sender see it
            // Receiver sees it
            for (let [id, name] of onlineUsers.entries()) {
                if (name === payload.target) {
                    io.to(id).emit('chat-message', formatted);
                }
            }
        } else {
            io.emit('chat-message', formatted);
        }
    });

    socket.on('disconnect', async () => {
        const name = onlineUsers.get(socket.id);
        if (name) {
            await User.updateOne({ username: name }, { lastSeen: new Date() });
            io.emit('status-update', { username: name, status: 'offline' });
            onlineUsers.delete(socket.id);
            adminSockets.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
