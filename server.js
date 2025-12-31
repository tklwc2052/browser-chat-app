require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); // <--- 1. IMPORT PATH

const app = express();
const server = http.createServer(app);

// Buffer limit 10MB for GIFs/Images
const io = socketIo(server, {
    maxHttpBufferSize: 1e7 
});

// --- SERVE STATIC FILES ---
// 2. TELL EXPRESS TO LOOK IN THE 'public' FOLDER
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1); 

// --- MONGODB CONNECTION ---
// Uses MONGO_URI from Render settings, or defaults to localhost if running locally
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';

mongoose.connect(mongoURI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    avatar: String,
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const dmSchema = new mongoose.Schema({
    participants: [String], // Stores ["UserA", "UserB"] sorted alphabetically
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

// --- GLOBAL VARIABLES ---
const users = {};        // Maps socket.id -> { username, avatar, ... }
const vcUsers = {};      // Maps socket.id -> { username, isMuted }
const messageHistory = []; // In-memory history for public chat

// --- HELPER FUNCTIONS ---

function formatMessage(username, text, avatar, image, isPm = false, replyTo = null) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        username,
        text,
        time,
        avatar,
        image,
        isPm,
        replyTo,
        timestamp: new Date()
    };
}

function addToHistory(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > 50) {
        messageHistory.shift(); // Keep last 50 public messages
    }
}

function findSocketIdByUsername(username) {
    for (let id in users) {
        if (users[id].username === username) {
            return id;
        }
    }
    return null;
}

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    console.log('New Client Connected:', socket.id);

    // 1. Handle User Join / Set Username
    socket.on('set-username', async ({ username, avatar }) => {
        const existingSocket = findSocketIdByUsername(username);
        if (existingSocket && existingSocket !== socket.id) {
            socket.emit('username-taken');
            return;
        }

        // Save user to memory
        users[socket.id] = { username, avatar, id: socket.id };
        
        // Update Database (Last Seen / Avatar)
        try {
            await User.findOneAndUpdate(
                { username }, 
                { username, avatar, lastSeen: new Date() },
                { upsert: true, new: true }
            );
        } catch (err) {
            console.error("DB Error updating user:", err);
        }

        // Notify user they joined & send public history
        socket.emit('user-joined', { username, history: messageHistory });
        
        // Notify others
        socket.broadcast.emit('chat-message', formatMessage('System', `${username} joined the chat.`));
        io.emit('user-status-change', { username, status: 'online', avatar });
        
        // Refresh sidebar lists
        broadcastUserList();
    });

    // 2. Public Chat Messages
    socket.on('chat-message', (data) => {
        const user = users[socket.id];
        if (user) {
            const msg = formatMessage(user.username, data.text, user.avatar, data.image, false, data.replyTo);
            addToHistory(msg);
            io.emit('chat-message', msg);
        }
    });

    // 3. Typing Indicators
    socket.on('typing', () => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('typing', user.username);
    });

    socket.on('stop-typing', () => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('stop-typing', user.username);
    });

    // 4. --- DIRECT MESSAGES ---
    socket.on('send-dm', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        
        const { target, text, image, replyTo } = data;
        
        // Create formatted message
        const msgObj = formatMessage(user.username, text, user.avatar, image, true, replyTo);
        
        // Send to sender (so it shows in your own chat immediately)
        socket.emit('dm-received', { from: user.username, to: target, message: msgObj });
        
        // Send to recipient (if online)
        const targetSocketId = findSocketIdByUsername(target);
        if (targetSocketId) {
            io.to(targetSocketId).emit('dm-received', { from: user.username, to: target, message: msgObj });
        }

        // Save to Database
        try {
            const participants = [user.username, target].sort();
            await DM.findOneAndUpdate(
                { participants: participants },
                { $push: { messages: msgObj } },
                { upsert: true }
            );
        } catch (err) {
            console.error("Error saving DM:", err);
        }
    });

    // 5. Load DM History
    socket.on('get-dm-history', async ({ target }) => {
        const user = users[socket.id];
        if (!user) return;

        try {
            const participants = [user.username, target].sort();
            const conversation = await DM.findOne({ participants });
            
            if (conversation && conversation.messages) {
                socket.emit('dm-history', { 
                    target: target, 
                    messages: conversation.messages 
                });
            } else {
                socket.emit('dm-history', { target: target, messages: [] });
            }
        } catch (err) {
            console.error("Error fetching DM history:", err);
        }
    });

    // 6. Voice Chat Handling
    socket.on('vc-join', () => {
        const user = users[socket.id];
        if (user) {
            vcUsers[socket.id] = { username: user.username, isMuted: false };
            broadcastVCUserList();
            
            // Log in public chat
            const joinMsg = formatMessage('System', `${user.username} joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);

            // Signal to existing VC users
            socket.broadcast.emit('vc-prepare-connection', socket.id);
        }
    });

    socket.on('vc-leave', () => {
        if (vcUsers[socket.id]) {
            const userData = users[socket.id];
            delete vcUsers[socket.id];
            
            if (userData) {
                const leaveMsg = formatMessage('System', `${userData.username} left Voice Chat.`);
                io.emit('chat-message', leaveMsg);
                addToHistory(leaveMsg);
                socket.broadcast.emit('vc-user-left', socket.id);
            }
        }
        broadcastVCUserList();
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });

    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });

    // 7. Disconnect Handling
    socket.on('disconnect', async () => {
        const user = users[socket.id];
        if (user) {
            // Update DB to show when they left
            try {
                await User.findOneAndUpdate({ username: user.username }, { lastSeen: Date.now() });
            } catch (e) { console.error(e); }

            // Handle VC cleanup
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList();
                socket.broadcast.emit('vc-user-left', socket.id);
            }

            // Remove from active users
            delete users[socket.id];

            // Notify chat
            const leaveMsg = formatMessage('System', `${user.username} has left.`);
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            
            io.emit('user-status-change', { username: user.username, status: 'offline' });
            broadcastUserList();
        }
        console.log('Client Disconnected:', socket.id);
    });
});

// --- BROADCAST HELPERS ---

async function broadcastUserList() {
    // We want to send both online users AND offline users (from DB)
    try {
        const allDocs = await User.find({}); // Fetch all registered users
        const userList = allDocs.map(doc => {
            // Check if currently online
            const isOnline = Object.values(users).some(u => u.username === doc.username);
            return {
                username: doc.username,
                avatar: doc.avatar,
                status: isOnline ? 'online' : 'offline',
                lastSeen: doc.lastSeen
            };
        });
        io.emit('update-user-list', userList);
    } catch (err) {
        // Fallback if DB fails: just send online users
        const onlineOnly = Object.values(users).map(u => ({
            username: u.username,
            avatar: u.avatar,
            status: 'online'
        }));
        io.emit('update-user-list', onlineOnly);
    }
}

function broadcastVCUserList() {
    const list = Object.values(vcUsers);
    io.emit('vc-user-list', list);
}

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
