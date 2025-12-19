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

// --- 2. DEFINE DATABASE SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    avatar: String,
    lastSeen: { type: Date, default: Date.now },
    isMuted: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    text: String,
    image: String,
    sender: String,
    avatar: String,
    type: { type: String, default: 'general' }, // 'general', 'private', 'system'
    target: String, // Receiver username (for DMs)
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// --- SERVER SETUP ---
app.use(express.static('public'));
app.set('trust proxy', 1); 

// Helper: Format message for frontend
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

io.on('connection', (socket) => {
    // --- ON JOIN ---
    socket.on('set-username', async (data) => {
        const { username, avatar } = data;
        const cleanName = username.trim();

        // Update/Create User in DB
        let user = await User.findOne({ username: cleanName });
        if (!user) {
            user = await User.create({ username: cleanName, avatar });
        } else {
            user.avatar = avatar; 
            user.lastSeen = new Date();
            await user.save();
        }

        onlineUsers.set(socket.id, cleanName);

        // 1. Send Global History (Last 50)
        const globalMsgs = await Message.find({ type: { $in: ['general', 'system'] } })
            .sort({ timestamp: -1 }).limit(50);
        socket.emit('history', globalMsgs.reverse().map(formatMsg));

        // 2. Send DM History (The "Mailbox")
        // Get ALL private messages where I am sender OR receiver
        const myDms = await Message.find({
            type: 'private',
            $or: [{ target: cleanName }, { sender: cleanName }]
        }).sort({ timestamp: 1 });
        
        // Group them for the frontend
        const dmHistory = {};
        myDms.forEach(msg => {
            // Create a unique key for the conversation (e.g. "Alice:Bob")
            const otherPerson = (msg.sender === cleanName) ? msg.target : msg.sender;
            const key = [cleanName, otherPerson].sort().join(':');
            
            if (!dmHistory[key]) dmHistory[key] = [];
            dmHistory[key].push(formatMsg(msg));
        });
        socket.emit('dm-history-sync', dmHistory);

        // 3. Send User List
        const allUsers = await User.find({}).sort({ lastSeen: -1 });
        io.emit('user-list-update', allUsers);
        
        // Announce
        io.emit('status-update', { username: cleanName, status: 'online' });
    });

    // --- ON MESSAGE ---
    socket.on('chat-message', async (payload) => {
        const senderName = onlineUsers.get(socket.id);
        if (!senderName) return;

        // Save to DB
        const newMsg = await Message.create({
            text: payload.text,
            image: payload.image,
            sender: senderName,
            avatar: payload.avatar, // In a real app we'd fetch this from DB to be safe
            type: payload.type || 'general',
            target: payload.target
        });

        const formatted = formatMsg(newMsg);

        if (payload.type === 'private' && payload.target) {
            // Send to Me (Sender)
            socket.emit('chat-message', formatted);
            
            // Send to Target (if online)
            for (let [id, name] of onlineUsers.entries()) {
                if (name === payload.target) {
                    io.to(id).emit('chat-message', formatted);
                }
            }
        } else {
            // Global Message
            io.emit('chat-message', formatted);
        }
    });

    // --- TYPING & VC (Pass-through) ---
    socket.on('typing-start', () => {
        const name = onlineUsers.get(socket.id);
        if(name) socket.broadcast.emit('user-typing', name);
    });
    socket.on('typing-stop', () => {
        const name = onlineUsers.get(socket.id);
        if(name) socket.broadcast.emit('user-stopped-typing', name);
    });

    socket.on('disconnect', async () => {
        const name = onlineUsers.get(socket.id);
        if (name) {
            await User.updateOne({ username: name }, { lastSeen: new Date() });
            io.emit('status-update', { username: name, status: 'offline' });
            onlineUsers.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
