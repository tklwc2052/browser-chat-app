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

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 

// --- Admin State ---
const mutedUsers = new Set(); // Stores LOWERCASE usernames
const bannedIPs = new Map();  
const bannedHistory = {};     

const ADMIN_USERNAME = 'kl_'; 

// --- Utility Functions ---
function formatMessage(sender, text, avatar = null, image = null, isPm = false) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    let finalAvatar = avatar;
    if (!finalAvatar && userAvatarCache[sender]) {
        finalAvatar = userAvatarCache[sender];
    }
    if (!finalAvatar && sender !== 'System') {
        finalAvatar = 'placeholder-avatar.png';
    }

    if (sender === 'System' || sender === 'Announcement') {
        return {
            text: `**${sender}** ${text} [${time}]`,
            sender: sender,
            avatar: null,
            time: time,
            type: 'system'
        };
    }
    
    return {
        text: text, 
        image: image, 
        sender: sender,
        avatar: finalAvatar, 
        time: time,
        type: isPm ? 'pm' : 'general'
    };
}

function getDmKey(user1, user2) {
    return [user1, user2].sort();
}

function broadcastUserList() {
    io.emit('user-list-update', Object.values(users));
}

function broadcastVCUserList() {
    io.emit('vc-user-list-update', Object.values(vcUsers));
}

function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}

function findSocketIdByUsername(username) {
    return Object.keys(users).find(id => 
        users[id].username.toLowerCase() === username.toLowerCase()
    );
}

function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address;
}

app.use(express.static('public'));

io.on('connection', async (socket) => {
    // --- 0. Ban Check ---
    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        console.log(`Banned connection attempt from ${clientIp}`);
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    console.log(`User connected: ${socket.id} (IP: ${clientIp})`);

    socket.emit('history', messageHistory);
    broadcastUserList();
    broadcastVCUserList(); 

    // --- NEW: Send Sidebar User List (Persistent) ---
    try {
        const allDbUsers = await User.find({});
        const sidebarList = allDbUsers.map(u => ({
            username: u.username,
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        socket.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar fetch error", err); }

    // --- 1. Set Username ---
    socket.on('set-username', async ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        const newAvatar = avatar || 'placeholder-avatar.png'; 

        if (!username) return;

        if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && oldUsername !== ADMIN_USERNAME) {
             // In a real app, you'd password protect this.
        }

        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.keys(users).some(id => 
            id !== socket.id && users[id].username.toLowerCase() === usernameLower
        );

        if (isDuplicate) {
            socket.emit('chat-message', formatMessage('System', `The username '${username}' is already taken.`));
            return;
        }

        userAvatarCache[username] = newAvatar;
        users[socket.id] = { username, avatar: newAvatar, id: socket.id };

        // --- MONGODB UPSERT ---
        try {
            await User.findOneAndUpdate(
                { username: username },
                { avatar: newAvatar, lastSeen: Date.now() },
                { upsert: true, new: true }
            );
        } catch(e) { console.error("DB Save Error", e); }
        // ----------------------

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }
        
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
        }
        broadcastUserList();

        // Broadcast sidebar status update
        io.emit('user-status-change', { username: username, online: true, avatar: newAvatar });
    });

    // --- 2. Chat Messages ---
    socket.on('chat-message', (payload) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;

        // Check Mute
        if (mutedUsers.has(sender.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are currently muted and cannot speak.'));
            return;
        }

        let msgText = '';
        let msgImage = null;

        if (typeof payload === 'string') {
            msgText = payload;
        } else if (typeof payload === 'object') {
            msgText = payload.text || '';
            msgImage = payload.image || null;
        }

        // --- COMMANDS ---
        if (msgText.startsWith('/')) {
            const parts = msgText.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1); 
            
            // Standard /msg command (Legacy support preserved)
            if (command === 'msg') {
                const targetUsername = parts[1];
                const privateText = parts.slice(2).join(' ').trim();
                
                if (!targetUsername || !privateText) {
                    socket.emit('chat-message', formatMessage('System', `Usage: /msg <username> <message>`));
                    return;
                }

                const recipientId = findSocketIdByUsername(targetUsername);

                if (!recipientId) {
                    socket.emit('chat-message', formatMessage('System', `User '${targetUsername}' not found.`));
                } else {
                    const now = new Date();
                    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                    const senderAvatar = userAvatarCache[sender] || userData.avatar;

                    const pmObject = {
                        text: privateText,
                        type: 'private',
                        sender: sender,
                        target: users[recipientId].username,
                        time: time,
                        avatar: senderAvatar
                    };

                    socket.emit('chat-message', pmObject);
                    io.to(recipientId).emit('chat-message', pmObject);
                }
                return; 
            } 
            
            // --- ADMIN COMMANDS ---
            if (sender === ADMIN_USERNAME) {
                const targetName = args[0];
                const reason = args.slice(1).join(' ') || 'No reason provided';
                
                if (command === 'server' && args.length > 0) {
                    const serverMsg = formatMessage('Announcement', `: **${args.join(' ')}**`);
                    io.emit('chat-message', serverMsg);
                    addToHistory(serverMsg);
                    return;
                } else if (command === 'clear') {
                    messageHistory.length = 0;
                    io.emit('clear-chat');
                    const clearMsg = formatMessage('System', `Chat history cleared by admin.`);
                    io.emit('chat-message', clearMsg);
                    addToHistory(clearMsg);
                    return;
                } else if (command === 'mute') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /mute <username> [reason]'));
                    const targetId = findSocketIdByUsername(targetName);
                    const realName = targetId ? users[targetId].username : targetName;
                    
                    mutedUsers.add(realName.toLowerCase());
                    const muteMsg = formatMessage('System', `**${realName}** was muted by Admin. Reason: ${reason}`);
                    io.emit('chat-message', muteMsg);
                    return;
                } else if (command === 'unmute') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /unmute <username>'));
                    if (mutedUsers.has(targetName.toLowerCase())) {
                        mutedUsers.delete(targetName.toLowerCase());
                        const targetId = findSocketIdByUsername(targetName);
                        const realName = targetId ? users[targetId].username : targetName;
                        socket.emit('chat-message', formatMessage('System', `**${realName}** was unmuted.`));
                    }
                    return;
                } else if (command === 'kick') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /kick <username> [reason]'));
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                        io.to(targetId).emit('chat-message', formatMessage('System', `You have been kicked. Reason: ${reason}`));
                        io.sockets.sockets.get(targetId)?.disconnect();
                        io.emit('chat-message', formatMessage('System', `**${targetName}** was kicked by Admin.`));
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} not found.`));
                    }
                    return;
                } else if (command === 'ban') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /ban <username> [reason]'));
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                         const ip = getClientIp(io.sockets.sockets.get(targetId));
                         bannedIPs.set(ip, reason);
                         io.to(targetId).emit('chat-message', formatMessage('System', `You have been BANNED. Reason: ${reason}`));
                         io.sockets.sockets.get(targetId)?.disconnect();
                         io.emit('chat-message', formatMessage('System', `**${targetName}** was BANNED by Admin.`));
                    } else {
                         // Ban by name if offline? Complex in memory, skipping for safety
                         socket.emit('chat-message', formatMessage('System', `User ${targetName} not found online.`));
                    }
                    return;
                }
            }
        }

        // Standard Message Broadcast
        const msgObj = formatMessage(sender, msgText, userData.avatar, msgImage);
        addToHistory(msgObj);
        io.emit('chat-message', msgObj);
    });

    // --- NEW: DM Logic (MongoDB) ---
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
                { $push: { messages: { $each: [msgObj], $slice: -50 } } }, 
                { upsert: true }
            );
        } catch(e) { console.error("DM Save Error", e); }

        // Send to Sender
        socket.emit('dm-received', { from: sender.username, to: data.target, message: msgObj });
        
        // Send to Receiver
        const targetSockets = Object.values(users).filter(u => u.username === data.target);
        targetSockets.forEach(u => {
            // Reusing local 'users' object to find socket IDs
            const targetSocketId = Object.keys(users).find(key => users[key].username === u.username);
            if(targetSocketId) {
                io.to(targetSocketId).emit('dm-received', { from: sender.username, to: data.target, message: msgObj });
            }
        });
    });

    // --- 3. Voice Chat Logic (Preserved) ---
    socket.on('vc-join', () => {
        if (users[socket.id]) {
            vcUsers[socket.id] = {
                id: socket.id,
                username: users[socket.id].username,
                avatar: users[socket.id].avatar,
                isMuted: false
            };
            
            const joinMsg = formatMessage('System', `**${users[socket.id].username}** joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);

            broadcastVCUserList();
        }
    });

    socket.on('vc-leave', () => {
        if (vcUsers[socket.id]) {
            const userData = users[socket.id];
            delete vcUsers[socket.id];
            if (userData) {
                const leaveMsg = formatMessage('System', `**${userData.username}** left Voice Chat.`);
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

    // --- 4. Typing Indicators (Preserved) ---
    socket.on('typing-start', () => {
        const user = users[socket.id];
        if (user) {
            socket.broadcast.emit('user-typing', user.username);
        }
    });

    socket.on('typing-stop', () => {
        const user = users[socket.id];
        if (user) {
            socket.broadcast.emit('user-stopped-typing', user.username);
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id);
            }
            
            const leaveMsg = formatMessage('System', `**${user.username}** has left the chat.`);
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            broadcastUserList();
            
            // Sidebar Update
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
