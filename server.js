require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

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
    participants: [String], 
    messages: [{
        sender: String,
        text: String,
        image: String,
        avatar: String,
        time: String,
        timestamp: { type: Date, default: Date.now }
    }]
});
// Index for speed
dmSchema.index({ participants: 1 });
const DM = mongoose.model('DM', dmSchema);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 

const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = 'kl_'; 

// --- Utility Functions ---
function formatMessage(sender, text, avatar = null, image = null, isPm = false) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    let finalAvatar = avatar;
    if (!finalAvatar && userAvatarCache[sender]) finalAvatar = userAvatarCache[sender];
    if (!finalAvatar && sender !== 'System') finalAvatar = 'placeholder-avatar.png';

    if (sender === 'System' || sender === 'Announcement') {
        return {
            text: text, 
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

function broadcastVCUserList() {
    io.emit('vc-user-list-update', Object.values(vcUsers));
}

function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}

function findSocketIdByUsername(username) {
    return Object.keys(users).find(id => users[id].username.toLowerCase() === username.toLowerCase());
}

function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address;
}

app.use(express.static('public'));

io.on('connection', async (socket) => {
    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    // Send history on connect
    socket.emit('history', messageHistory);
    // Removed broadcastUserList() call here
    broadcastVCUserList(); 

    try {
        const allDbUsers = await User.find({}).lean();
        const sidebarList = allDbUsers.map(u => ({
            username: u.username,
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        socket.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar fetch error", err); }

    // Client requests global history refresh
    socket.on('get-history', () => {
        socket.emit('history', messageHistory);
    });

    socket.on('set-username', async ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        const newAvatar = avatar || 'placeholder-avatar.png'; 

        if (!username) return;

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

        try {
            await User.findOneAndUpdate(
                { username: username },
                { avatar: newAvatar, lastSeen: Date.now() },
                { upsert: true, new: true }
            );
        } catch(e) { console.error("DB Save Error", e); }

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }
        
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User ${username} joined the chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
        }
        // Removed broadcastUserList() call here
        io.emit('user-status-change', { username: username, online: true, avatar: newAvatar });
    });

    socket.on('chat-message', (payload) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;

        if (mutedUsers.has(sender.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are currently muted.'));
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

        if (msgText.startsWith('/')) {
            const parts = msgText.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1); 
            
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
                    const pmObject = {
                        text: privateText,
                        type: 'private',
                        sender: sender,
                        target: users[recipientId].username,
                        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                        avatar: userAvatarCache[sender] || userData.avatar
                    };
                    socket.emit('chat-message', pmObject);
                    io.to(recipientId).emit('chat-message', pmObject);
                }
                return; 
            } 
            
            if (sender === ADMIN_USERNAME) {
                const targetName = args[0];
                const reason = args.slice(1).join(' ') || 'No reason';
                
                if (command === 'server' && args.length > 0) {
                    const serverMsg = formatMessage('Announcement', `: **${args.join(' ')}**`);
                    io.emit('chat-message', serverMsg);
                    addToHistory(serverMsg);
                    return;
                } else if (command === 'clear') {
                    messageHistory.length = 0;
                    io.emit('clear-chat');
                    const clearMsg = formatMessage('System', `Chat history cleared.`);
                    io.emit('chat-message', clearMsg);
                    addToHistory(clearMsg);
                    return;
                } else if (command === 'mute') {
                    if (targetName) {
                        mutedUsers.add(targetName.toLowerCase());
                        io.emit('chat-message', formatMessage('System', `${targetName} muted. Reason: ${reason}`));
                    }
                    return;
                } else if (command === 'unmute') {
                    if (targetName && mutedUsers.has(targetName.toLowerCase())) {
                        mutedUsers.delete(targetName.toLowerCase());
                        socket.emit('chat-message', formatMessage('System', `${targetName} unmuted.`));
                    }
                    return;
                } else if (command === 'kick') {
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                        io.to(targetId).emit('chat-message', formatMessage('System', `You have been kicked. ${reason}`));
                        io.sockets.sockets.get(targetId)?.disconnect();
                        io.emit('chat-message', formatMessage('System', `${targetName} kicked.`));
                    }
                    return;
                } else if (command === 'ban') {
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                         const ip = getClientIp(io.sockets.sockets.get(targetId));
                         bannedIPs.set(ip, reason);
                         io.to(targetId).emit('chat-message', formatMessage('System', `You have been BANNED. ${reason}`));
                         io.sockets.sockets.get(targetId)?.disconnect();
                         io.emit('chat-message', formatMessage('System', `${targetName} BANNED.`));
                    }
                    return;
                }
            }
        }

        const msgObj = formatMessage(sender, msgText, userData.avatar, msgImage);
        addToHistory(msgObj);
        io.emit('chat-message', msgObj);
    });

    socket.on('fetch-dm-history', async (targetUsername) => {
        const user = users[socket.id];
        if(!user) return;
        try {
            const participants = getDmKey(user.username, targetUsername);
            const conversation = await DM.findOne({ participants: participants }).lean();
            const history = conversation ? conversation.messages : [];
            socket.emit('dm-history', { target: targetUsername, messages: history });
        } catch(e) { console.error("DM Fetch Error", e); }
    });

    socket.on('send-dm', async (data) => {
        const sender = users[socket.id];
        if (!sender) return;
        
        const msgObj = formatMessage(sender.username, data.message, sender.avatar, data.image, true);
        const participants = getDmKey(sender.username, data.target);

        try {
            await DM.findOneAndUpdate(
                { participants: participants },
                { $push: { messages: { $each: [msgObj], $slice: -50 } } }, 
                { upsert: true }
            );
        } catch(e) { console.error("DM Save Error", e); }

        socket.emit('dm-received', { from: sender.username, to: data.target, message: msgObj });
        
        const targetSockets = Object.values(users).filter(u => u.username === data.target);
        targetSockets.forEach(u => {
            const targetSocketId = Object.keys(users).find(key => users[key].username === u.username);
            if(targetSocketId) {
                io.to(targetSocketId).emit('dm-received', { from: sender.username, to: data.target, message: msgObj });
            }
        });
    });

    socket.on('typing-start', (target) => {
        const user = users[socket.id];
        if(!user) return;
        
        if (!target || target === 'global') {
            socket.broadcast.emit('user-typing', { username: user.username, scope: 'global' });
        } else {
            const targetSocketId = Object.keys(users).find(k => users[k].username === target);
            if(targetSocketId) {
                io.to(targetSocketId).emit('user-typing', { username: user.username, scope: 'dm' });
            }
        }
    });

    socket.on('typing-stop', (target) => {
        const user = users[socket.id];
        if(!user) return;

        if (!target || target === 'global') {
            socket.broadcast.emit('user-stopped-typing', { username: user.username, scope: 'global' });
        } else {
             const targetSocketId = Object.keys(users).find(k => users[k].username === target);
             if(targetSocketId) {
                 io.to(targetSocketId).emit('user-stopped-typing', { username: user.username, scope: 'dm' });
             }
        }
    });

    // VC
    socket.on('vc-join', () => {
        if (users[socket.id]) {
            vcUsers[socket.id] = { id: socket.id, username: users[socket.id].username, avatar: users[socket.id].avatar, isMuted: false };
            const joinMsg = formatMessage('System', `${users[socket.id].username} joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            broadcastVCUserList();
            
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

    socket.on('vc-mute-toggle', (isMuted) => { if (vcUsers[socket.id]) { vcUsers[socket.id].isMuted = isMuted; broadcastVCUserList(); } });
    
    socket.on('signal', (data) => { 
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal }); 
    });
    
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            if (vcUsers[socket.id]) { delete vcUsers[socket.id]; broadcastVCUserList(); socket.broadcast.emit('vc-user-left', socket.id); }
            const leaveMsg = formatMessage('System', `${user.username} has left.`);
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            // Removed broadcastUserList() call here
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
