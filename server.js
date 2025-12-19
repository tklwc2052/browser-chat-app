require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- RENDER SPECIFIC FIX ---
app.set('trust proxy', 1);

// --- MONGODB CONNECTION ---
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
    participants: [String], // [userA, userB] sorted alphabetically
    messages: [{
        sender: String,
        text: String,
        image: String,
        avatar: String,
        time: String,
        timestamp: { type: Date, default: Date.now }
    }]
});
const DM = mongoose.model('DM', dmSchema);

// --- State Management (Live) ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 

// --- Admin State ---
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = 'kl_'; 

app.use(express.static('public'));

// --- Utility Functions ---
function formatMessage(sender, text, avatar = null, image = null, isPm = false) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    let finalAvatar = avatar;
    // Fallback if avatar not provided
    if (!finalAvatar && userAvatarCache[sender]) finalAvatar = userAvatarCache[sender];
    if (!finalAvatar && sender !== 'System') finalAvatar = 'placeholder-avatar.png';

    // System Message Formatting
    if (sender === 'System' || sender === 'Announcement') {
        return {
            text: `**${sender}** ${text} [${time}]`,
            sender: sender,
            avatar: null,
            time: time,
            type: 'system',
            timestamp: Date.now()
        };
    }
    
    return {
        text: text, 
        image: image, 
        sender: sender, 
        avatar: finalAvatar, 
        time: time,
        type: isPm ? 'pm' : 'general', 
        timestamp: Date.now()
    };
}

function getDmKey(user1, user2) {
    return [user1, user2].sort();
}

io.on('connection', async (socket) => {
    // 1. Check Ban Status
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (bannedIPs.has(clientIp)) {
        socket.emit('banned', { reason: bannedIPs.get(clientIp) });
        socket.disconnect();
        return;
    }

    // 2. Send Global History & Live User List
    socket.emit('history', messageHistory);
    socket.emit('update-user-list', Object.values(users));
    
    // 3. Send Persistent Sidebar List (From MongoDB)
    try {
        const allDbUsers = await User.find({});
        const sidebarList = allDbUsers.map(u => ({
            username: u.username,
            avatar: u.avatar,
            // Check if they are currently in the 'users' object
            online: Object.values(users).some(live => live.username === u.username)
        }));
        socket.emit('sidebar-user-list', sidebarList);
    } catch (err) {
        console.error("Error fetching users for sidebar:", err);
    }

    // --- JOIN EVENT ---
    socket.on('join', async (userData) => {
        // Admin Logic (Legacy)
        if (userData.username.startsWith(ADMIN_USERNAME)) {
            // Admin logic placeholder - existing logic assumed handled by client side knowledge or simple checks
        }

        // Live State
        users[socket.id] = { 
            username: userData.username, 
            avatar: userData.avatar, 
            id: socket.id, 
            ip: clientIp 
        };
        userAvatarCache[userData.username] = userData.avatar;

        // DB Update (Upsert User)
        try {
            await User.findOneAndUpdate(
                { username: userData.username },
                { avatar: userData.avatar, lastSeen: Date.now() },
                { upsert: true, new: true }
            );
        } catch(e) { console.error("DB User Save Error", e); }

        // Broadcasts
        io.emit('chat-message', formatMessage('System', `**${userData.username}** has joined the chat.`));
        io.emit('update-user-list', Object.values(users));
        
        // Update Sidebar for everyone
        io.emit('user-status-change', { 
            username: userData.username, 
            online: true, 
            avatar: userData.avatar 
        });
    });

    // --- CHAT MESSAGES & ADMIN COMMANDS ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user) {
            // Mute Check
            if (mutedUsers.has(user.username.toLowerCase())) {
                socket.emit('chat-message', formatMessage('System', 'You are muted.'));
                return;
            }

            const msgText = data.message;

            // Admin Commands (Simplified implementation of your existing logic)
            if (msgText.startsWith('/')) {
                const parts = msgText.split(' ');
                const cmd = parts[0].toLowerCase();
                const target = parts[1];
                
                // Only allow admin username
                if (user.username.startsWith(ADMIN_USERNAME)) {
                    if (cmd === '/kick' && target) {
                        const targetSocket = Object.values(users).find(u => u.username === target);
                        if (targetSocket) {
                            io.to(targetSocket.id).emit('kick');
                            io.sockets.sockets.get(targetSocket.id)?.disconnect();
                            io.emit('chat-message', formatMessage('System', `**${target}** was kicked.`));
                        }
                        return;
                    }
                    if (cmd === '/ban' && target) {
                         const targetSocket = Object.values(users).find(u => u.username === target);
                         if (targetSocket) {
                             bannedIPs.set(targetSocket.ip, "Banned by Admin");
                             io.to(targetSocket.id).emit('banned', { reason: "Banned by Admin" });
                             io.sockets.sockets.get(targetSocket.id)?.disconnect();
                             io.emit('chat-message', formatMessage('System', `**${target}** was BANNED.`));
                         }
                         return;
                    }
                    if (cmd === '/mute' && target) {
                        mutedUsers.add(target.toLowerCase());
                        io.emit('chat-message', formatMessage('System', `**${target}** was muted.`));
                        return;
                    }
                    if (cmd === '/clear') {
                        messageHistory.length = 0;
                        io.emit('history', []);
                        io.emit('chat-message', formatMessage('System', 'Chat cleared.'));
                        return;
                    }
                }
            }

            // Standard Global Message
            const msgObj = formatMessage(user.username, msgText, user.avatar, data.image);
            messageHistory.push(msgObj);
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
            io.emit('chat-message', msgObj);
        }
    });

    // --- DM LOGIC (MongoDB) ---

    socket.on('fetch-dm-history', async (targetUsername) => {
        const user = users[socket.id];
        if(!user) return;
        
        try {
            const participants = getDmKey(user.username, targetUsername);
            const conversation = await DM.findOne({ participants: participants });
            const history = conversation ? conversation.messages : [];
            socket.emit('dm-history', { target: targetUsername, messages: history });
        } catch(e) { console.error("DM Fetch Error", e); }
    });

    socket.on('send-dm', async (data) => {
        const sender = users[socket.id];
        if (!sender) return;
        
        const msgObj = formatMessage(sender.username, data.message, sender.avatar, data.image, true);
        const participants = getDmKey(sender.username, data.target);

        // Update DB
        try {
            await DM.findOneAndUpdate(
                { participants: participants },
                { $push: { messages: { $each: [msgObj], $slice: -50 } } }, // Store last 50 msgs
                { upsert: true }
            );
        } catch(e) { console.error("DM Save Error", e); }

        // Send to Sender (Immediate UI update)
        socket.emit('dm-received', { from: sender.username, to: data.target, message: msgObj });
        
        // Send to Receiver (Find all sockets for that username)
        const targetSockets = Object.values(users).filter(u => u.username === data.target);
        targetSockets.forEach(u => {
            io.to(u.id).emit('dm-received', { from: sender.username, to: data.target, message: msgObj });
        });
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            
            // VC Cleanup
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                io.emit('vc-update', Object.values(vcUsers)); // Simplified VC update event
            }

            io.emit('chat-message', formatMessage('System', `**${user.username}** has left.`));
            io.emit('update-user-list', Object.values(users));
            
            // Update Sidebar status
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });

    // --- TYPING & VC EVENTS (Pass-through) ---
    socket.on('typing-start', () => { if(users[socket.id]) socket.broadcast.emit('user-typing', users[socket.id].username); });
    socket.on('typing-stop', () => { if(users[socket.id]) socket.broadcast.emit('user-stopped-typing', users[socket.id].username); });
    
    // Voice Chat Signaling (Existing logic preserved)
    socket.on('vc-join', () => { 
        if(users[socket.id]) {
            vcUsers[socket.id] = { id: socket.id, username: users[socket.id].username, isMuted: false };
            io.emit('vc-update', Object.values(vcUsers));
        }
    });
    socket.on('vc-leave', () => {
        if(vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-update', Object.values(vcUsers));
        }
    });
    socket.on('signal', (data) => { io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal }); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
