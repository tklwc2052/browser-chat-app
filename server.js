require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Buffer limit 10MB for GIFs
const io = socketIo(server, {
    maxHttpBufferSize: 1e7 
});

app.set('trust proxy', 1); 

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
        messageId: String, // RENAMED from 'id' to fix Mongoose conflict
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

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 
let serverMOTD = "Welcome to the C&C Corp chat! Play nice."; 

const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = 'kl_'; 

// --- Utility Functions ---
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatMessage(sender, text, avatar = null, image = null, isPm = false, replyTo = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    let finalAvatar = avatar;
    if (!finalAvatar && userAvatarCache[sender]) finalAvatar = userAvatarCache[sender];
    if (!finalAvatar && sender !== 'System') finalAvatar = 'placeholder-avatar.png';

    if (sender === 'System' || sender === 'Announcement') {
        return { 
            id: generateId(),
            text: text, 
            sender: sender, 
            avatar: null, 
            time: time, 
            type: 'system' 
        };
    }
    
    return {
        id: generateId(),
        text: text, 
        image: image, 
        sender: sender, 
        avatar: finalAvatar, 
        time: time,
        replyTo: replyTo,
        type: isPm ? 'pm' : 'general',
        isEdited: false
    };
}

function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address;
}

function findSocketIdByUsername(username) {
    return Object.keys(users).find(id => users[id].username.toLowerCase() === username.toLowerCase());
}

function broadcastVCUserList() { 
    io.emit('vc-user-list-update', Object.values(vcUsers)); 
}

function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}

async function broadcastSidebarRefresh() {
    try {
        const allDbUsers = await User.find({}).lean();
        const sidebarList = allDbUsers.map(u => ({
            username: u.username,
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        io.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar update error", err); }
}

// Serve static files
app.use(express.static('public'));

// --- SOCKET LOGIC ---
io.on('connection', async (socket) => {
    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    // Send global history on join
    socket.emit('history', messageHistory);
    broadcastVCUserList(); 
    broadcastSidebarRefresh(); 

    setTimeout(() => {
        socket.emit('motd', serverMOTD);
    }, 100);

    socket.on('get-history', () => { socket.emit('history', messageHistory); });

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
            broadcastSidebarRefresh();
        }
        io.emit('user-status-change', { username: username, online: true, avatar: newAvatar });
    });

    socket.on('chat-message', async (payload) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;

        if (mutedUsers.has(sender.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are currently muted.'));
            return;
        }

        let msgText = '';
        let msgImage = null;
        let replyTo = null;

        if (typeof payload === 'string') {
            msgText = payload;
        } else if (typeof payload === 'object') {
            msgText = payload.text || '';
            msgImage = payload.image || null;
            replyTo = payload.replyTo || null;
        }

        // --- COMMAND HANDLING ---
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
                
                // Format the PM
                const pmObject = formatMessage(sender, privateText, userData.avatar, msgImage, true, replyTo);
                pmObject.target = targetUsername; 

                // FIX: SAVE DM TO DATABASE
                try {
                    const participants = [sender, targetUsername].sort();
                    await DM.findOneAndUpdate(
                        { participants },
                        { 
                            $push: { 
                                messages: {
                                    messageId: pmObject.id, // Use renamed field
                                    replyTo: pmObject.replyTo,
                                    sender: pmObject.sender,
                                    text: pmObject.text,
                                    image: pmObject.image,
                                    avatar: pmObject.avatar,
                                    time: pmObject.time,
                                    isEdited: false
                                } 
                            } 
                        },
                        { upsert: true, new: true }
                    );
                } catch(e) { console.error("DM Save Error:", e); }

                if (!recipientId) {
                    socket.emit('chat-message', formatMessage('System', `User '${targetUsername}' is offline but will see your message later.`));
                    socket.emit('dm-received', { from: sender, to: targetUsername, message: pmObject });
                } else {
                    socket.emit('dm-received', { from: sender, to: targetUsername, message: pmObject });
                    io.to(recipientId).emit('dm-received', { from: sender, to: targetUsername, message: pmObject });
                }
                return;
            }
            
            if (sender === ADMIN_USERNAME) {
                if (command === 'clear') {
                    messageHistory.length = 0;
                    io.emit('clear-chat');
                    io.emit('chat-message', formatMessage('System', 'Chat history cleared.'));
                    return;
                }
            }
        }

        // --- GLOBAL CHAT HANDLING ---
        const msgObj = formatMessage(sender, msgText, userData.avatar, msgImage, false, replyTo);
        addToHistory(msgObj);
        io.emit('chat-message', msgObj);
    });

    // FIX: LOAD DM HISTORY
    socket.on('fetch-dm-history', async (targetUser) => {
        const userData = users[socket.id];
        if(!userData) return;
        
        const participants = [userData.username, targetUser].sort();
        try {
            const conversation = await DM.findOne({ participants });
            if (conversation) {
                // Map messageId back to id for frontend
                const history = conversation.messages.map(m => ({
                    id: m.messageId,
                    replyTo: m.replyTo,
                    sender: m.sender,
                    text: m.text,
                    image: m.image,
                    avatar: m.avatar,
                    time: m.time,
                    isEdited: m.isEdited
                }));
                socket.emit('dm-history', { target: targetUser, messages: history });
            } else {
                socket.emit('dm-history', { target: targetUser, messages: [] });
            }
        } catch (e) {
            console.error("Error loading history:", e);
        }
    });

    // --- VOICE CHAT HANDLING ---
    socket.on('vc-join', () => {
        const user = users[socket.id];
        if (user) {
            vcUsers[socket.id] = { ...user, isMuted: false };
            broadcastVCUserList();
            
            const joinMsg = formatMessage('System', `${user.username} joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            
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
        io.to(data.target).emit('signal', { 
            sender: socket.id, 
            signal: data.signal 
        }); 
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
            
            const leaveMsg = formatMessage('System', `${user.username} has left.`);
            io.emit('chat-message', leaveMsg);
            
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });
});

// --- SERVER START ---
// FIX: We connect to DB first, THEN start listening.
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';

mongoose.connect(mongoURI)
    .then(() => {
        console.log('MongoDB Connected');
        const PORT = process.env.PORT || 10000;
        server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => {
        console.log('MongoDB Connection Error:', err);
        // Optional: process.exit(1);
    });
