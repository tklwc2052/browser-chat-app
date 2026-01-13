require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);

// --- 1. AUTOMATIC UPDATE MESSAGE ---
let SERVER_BUILD_DESC = "System Update"; 
const SERVER_BUILD_ID = Date.now(); 

try {
    if (fs.existsSync('build_desc.txt')) {
        SERVER_BUILD_DESC = fs.readFileSync('build_desc.txt', 'utf8').trim();
        console.log(`✅ Loaded Update Message: "${SERVER_BUILD_DESC}"`);
    }
} catch (e) {
    console.log("⚠️ build_desc.txt not found. Using default.");
}

const io = socketIo(server, { maxHttpBufferSize: 1e7 });

app.set('trust proxy', 1); 

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        try {
            const savedMessages = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
            messageHistory.push(...savedMessages.reverse());
        } catch (err) { console.error(err); }

        try {
            const savedMotd = await Config.findOne({ key: 'motd' });
            if (savedMotd) serverMOTD = savedMotd.value;
        } catch (err) { console.error(err); }

        try {
            const allBans = await Ban.find({});
            allBans.forEach(ban => bannedIPs.set(ban.ip, true));
        } catch (err) { console.error(err); }
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    displayName: String, 
    description: { type: String, default: "" }, 
    pronouns: { type: String, default: "" },
    avatar: String,
    lastIp: String, 
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const banSchema = new mongoose.Schema({
    username: String, ip: String, bannedAt: { type: Date, default: Date.now }, bannedBy: String
});
const Ban = mongoose.models.Ban || mongoose.model('Ban', banSchema);

const messageSchema = new mongoose.Schema({
    id: String, sender: String, senderDisplayName: String, text: String, image: String, avatar: String, time: String, replyTo: Object, type: String, isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now }
});
messageSchema.index({ timestamp: -1 }); 
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

const dmSchema = new mongoose.Schema({
    participants: [String], 
    messages: [{ id: String, replyTo: Object, sender: String, senderDisplayName: String, text: String, image: String, avatar: String, time: String, isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now } }]
});
dmSchema.index({ participants: 1 });
const DM = mongoose.models.DM || mongoose.model('DM', dmSchema);

const configSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String });
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 20; 
const userAvatarCache = {}; 
let serverMOTD = "Welcome to the C&C Corp chat! Play nice."; 
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const ADMIN_USERNAME = 'kl_'; 

// NEW: Track pending disconnects to prevent messages on page refresh/nav
const disconnectTimeouts = {}; 

// --- Utility Functions ---
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function formatMessage(sender, text, avatar = null, image = null, isPm = false, replyTo = null, senderDisplayName = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let finalAvatar = avatar;
    if (!finalAvatar && userAvatarCache[sender]) finalAvatar = userAvatarCache[sender];
    if (!finalAvatar && sender !== 'System') finalAvatar = 'placeholder-avatar.png';
    const finalDisplayName = senderDisplayName || sender;

    if (sender === 'System' || sender === 'Announcement') {
        return { id: generateId(), text, sender, senderDisplayName: sender, avatar: null, time, type: 'system', timestamp: now };
    }
    return { id: generateId(), text, image, sender, senderDisplayName: finalDisplayName, avatar: finalAvatar, time, replyTo, type: isPm ? 'pm' : 'general', isEdited: false, timestamp: now };
}

async function savePublicMessage(msgObj) {
    if (msgObj.type === 'pm') return;
    try {
        await new Message({
            id: msgObj.id, sender: msgObj.sender, senderDisplayName: msgObj.senderDisplayName, text: msgObj.text, image: msgObj.image, avatar: msgObj.avatar, time: msgObj.time, replyTo: msgObj.replyTo, type: msgObj.type, isEdited: msgObj.isEdited || false, timestamp: msgObj.timestamp || new Date()
        }).save();
    } catch (err) { console.error("Error saving public message:", err); }
}

function broadcastVCUserList() { io.emit('vc-user-list-update', Object.values(vcUsers)); }
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
async function broadcastSidebarRefresh() {
    try {
        const allDbUsers = await User.find({}).lean();
        const sidebarList = allDbUsers.map(u => ({
            username: u.username,
            displayName: u.displayName || u.username, 
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        io.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar update error", err); }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

io.on('connection', async (socket) => {
    socket.emit('system-version-check', { id: SERVER_BUILD_ID, description: SERVER_BUILD_DESC });
    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

    socket.emit('history', messageHistory);
    broadcastVCUserList(); 
    broadcastSidebarRefresh(); 
    setTimeout(() => { socket.emit('motd', serverMOTD); }, 100);

    socket.on('get-history', () => { socket.emit('history', messageHistory); });

    // --- REGISTER / LOGIN ---
    socket.on('set-username', async ({ username }) => {
        if (!username) return;
        const usernameLower = username.toLowerCase();
        
        // 1. CANCEL PENDING LEAVE MESSAGE
        // If they just refreshed or came from profile page, cancel the "User left" timer.
        if (disconnectTimeouts[usernameLower]) {
            clearTimeout(disconnectTimeouts[usernameLower]);
            delete disconnectTimeouts[usernameLower];
        }

        const isAlreadyOnline = Object.keys(users).some(id => 
            id !== socket.id && users[id].username.toLowerCase() === usernameLower
        );

        let dbUser = null;
        try { dbUser = await User.findOne({ username: username }); } catch(e) {}

        const displayName = dbUser ? (dbUser.displayName || username) : username;
        const avatar = dbUser ? (dbUser.avatar || 'placeholder-avatar.png') : 'placeholder-avatar.png';
        const description = dbUser ? (dbUser.description || "") : "";
        const pronouns = dbUser ? (dbUser.pronouns || "") : "";

        userAvatarCache[username] = avatar;
        users[socket.id] = { username, displayName, avatar, description, pronouns, id: socket.id };

        try {
            await User.findOneAndUpdate(
                { username: username },
                { lastSeen: Date.now(), lastIp: clientIp, $setOnInsert: { displayName: username, avatar: 'placeholder-avatar.png' } },
                { upsert: true, new: true }
            );
        } catch(e) { console.error(e); }

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].displayName = displayName;
            vcUsers[socket.id].avatar = avatar;
            broadcastVCUserList();
        }
        
        // Only announce join if they weren't already online
        if (!isAlreadyOnline) {
            const joinMsg = formatMessage('System', `${displayName} (${username}) joined the chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            savePublicMessage(joinMsg); 
        }

        broadcastSidebarRefresh();
        socket.emit('profile-info', { username, displayName, avatar, description, pronouns });
        io.emit('user-status-change', { username, displayName, online: true, avatar });
    });

    // --- GET OTHER USER PROFILE ---
    socket.on('get-user-profile', async (targetUsername) => {
        try {
            const dbUser = await User.findOne({ username: targetUsername }).lean();
            if (dbUser) {
                socket.emit('user-profile-data', {
                    username: dbUser.username,
                    displayName: dbUser.displayName || dbUser.username,
                    avatar: dbUser.avatar || 'placeholder-avatar.png',
                    description: dbUser.description || "",
                    pronouns: dbUser.pronouns || "",
                    lastSeen: dbUser.lastSeen
                });
            } else {
                socket.emit('user-profile-data', {
                    username: targetUsername,
                    displayName: targetUsername,
                    avatar: 'placeholder-avatar.png',
                    description: "", 
                    pronouns: "",
                    notFound: true
                });
            }
        } catch (e) {
            console.error("Fetch Profile Error", e);
        }
    });

    // --- UPDATE PROFILE ---
    socket.on('update-profile', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        const { displayName, avatar, description, pronouns } = data;
        
        if (displayName) user.displayName = displayName;
        if (avatar) {
            user.avatar = avatar;
            userAvatarCache[user.username] = avatar;
        }
        if (description !== undefined) user.description = description;
        if (pronouns !== undefined) user.pronouns = pronouns;

        try {
            await User.findOneAndUpdate(
                { username: user.username },
                { displayName: user.displayName, avatar: user.avatar, description: user.description, pronouns: user.pronouns }
            );
        } catch(e) { console.error("Profile Update Error", e); }

        broadcastSidebarRefresh();
        
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].displayName = user.displayName;
            vcUsers[socket.id].avatar = user.avatar;
            broadcastVCUserList();
        }

        socket.emit('chat-message', formatMessage('System', 'Profile updated successfully.'));
        socket.emit('profile-info', { 
            username: user.username, 
            displayName: user.displayName, 
            avatar: user.avatar, 
            description: user.description,
            pronouns: user.pronouns
        });
    });

    socket.on('chat-message', async (payload) => {
        const userData = users[socket.id] || { username: 'Anonymous', displayName: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;
        const senderDisplayName = userData.displayName || sender;

        if (mutedUsers.has(sender.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are currently muted.'));
            return;
        }

        let msgText = '';
        let msgImage = null;
        let replyTo = null;

        if (typeof payload === 'string') { msgText = payload; } 
        else if (typeof payload === 'object') {
            msgText = payload.text || ''; msgImage = payload.image || null; replyTo = payload.replyTo || null;
        }

        if (msgText.startsWith('/')) {
            const parts = msgText.trim().slice(1).split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);

            if (command === 'msg') {
                const targetUsername = parts[1];
                const privateText = parts.slice(2).join(' ').trim();
                if (!targetUsername || !privateText) { socket.emit('chat-message', formatMessage('System', `Usage: /msg <username> <message>`)); return; }
                const recipientId = findSocketIdByUsername(targetUsername);
                if (!recipientId) { socket.emit('chat-message', formatMessage('System', `User '${targetUsername}' not found.`)); } 
                else {
                    const pmObject = { 
                        id: generateId(), text: privateText, type: 'private', sender: sender, senderDisplayName: senderDisplayName, target: users[recipientId].username, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }), avatar: userAvatarCache[sender] || userData.avatar, replyTo: replyTo
                    };
                    socket.emit('chat-message', pmObject);
                    io.to(recipientId).emit('chat-message', pmObject);
                }
                return;
            }

            if (sender === ADMIN_USERNAME) {
                const targetName = args[0];
                if (command === 'server' && args.length > 0) {
                    const serverMsg = formatMessage('Announcement', `: **${args.join(' ')}**`);
                    io.emit('chat-message', serverMsg); addToHistory(serverMsg); savePublicMessage(serverMsg); return;
                }
                if (command === 'mute' && targetName) {
                    mutedUsers.add(targetName.toLowerCase()); const muteMsg = formatMessage('System', `User ${targetName} has been muted.`); io.emit('chat-message', muteMsg); addToHistory(muteMsg); savePublicMessage(muteMsg); return;
                }
                if (command === 'unmute' && targetName) {
                    mutedUsers.delete(targetName.toLowerCase()); const unmuteMsg = formatMessage('System', `User ${targetName} has been unmuted.`); io.emit('chat-message', unmuteMsg); addToHistory(unmuteMsg); savePublicMessage(unmuteMsg); return;
                }
                if (command === 'ban' && targetName) {
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                        const targetSocket = io.sockets.sockets.get(targetId);
                        const targetIp = getClientIp(targetSocket);
                        bannedIPs.set(targetIp, true);
                        try { await new Ban({ username: targetName, ip: targetIp, bannedBy: sender }).save(); } catch(e) {}
                        io.to(targetId).emit('chat-message', formatMessage('System', 'You have been banned.'));
                        targetSocket.disconnect(true);
                        const banMsg = formatMessage('System', `User ${targetName} has been banned.`);
                        io.emit('chat-message', banMsg); addToHistory(banMsg); savePublicMessage(banMsg);
                    }
                    return;
                }
                if (command === 'prune') {
                    messageHistory.length = 0; await Message.deleteMany({}); io.emit('history', []); io.emit('chat-message', formatMessage('System', 'Chat history has been cleared.')); return;
                }
                if (command === 'motd' && args.length > 0) {
                    serverMOTD = args.join(' ');
                    try { await Config.findOneAndUpdate({ key: 'motd' }, { value: serverMOTD }, { upsert: true }); } catch(e) {}
                    io.emit('motd', serverMOTD); io.emit('chat-message', formatMessage('System', `MOTD updated: ${serverMOTD}`)); return;
                }
            }
        }
        const messageObject = formatMessage(sender, msgText, userData.avatar, msgImage, false, replyTo, senderDisplayName);
        io.emit('chat-message', messageObject);
        addToHistory(messageObject);
        savePublicMessage(messageObject);
    });

    socket.on('join-vc', () => {
        const user = users[socket.id];
        if(user) {
            vcUsers[socket.id] = { id: socket.id, username: user.username, displayName: user.displayName, avatar: user.avatar };
            broadcastVCUserList(); socket.broadcast.emit('vc-user-joined', socket.id);
        }
    });
    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) { delete vcUsers[socket.id]; broadcastVCUserList(); socket.broadcast.emit('vc-user-left', socket.id); }
    });
    socket.on('signal', (data) => { io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal }); });
    
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const username = user.username.toLowerCase();
            delete users[socket.id];
            
            // Clean up VC immediately
            if (vcUsers[socket.id]) { 
                delete vcUsers[socket.id]; 
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id); 
            }

            // --- GRACE PERIOD LOGIC ---
            // Don't announce "Left" immediately. Wait 2 seconds.
            // If they reconnect (e.g. page navigation) within 2s, we cancel this.
            if (disconnectTimeouts[username]) clearTimeout(disconnectTimeouts[username]);

            disconnectTimeouts[username] = setTimeout(() => {
                // Check if the user is really gone (no other sockets with this username)
                const isStillOnline = Object.values(users).some(u => u.username.toLowerCase() === username);
                
                if (!isStillOnline) {
                    const leaveMsg = formatMessage('System', `${user.displayName} (${user.username}) has left.`);
                    io.emit('chat-message', leaveMsg); 
                    addToHistory(leaveMsg); 
                    savePublicMessage(leaveMsg);
                    io.emit('user-status-change', { username: user.username, online: false });
                }
                delete disconnectTimeouts[username];
            }, 2000); 
        }
    });
});

app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try { await Ban.deleteMany({}); bannedIPs.clear(); res.send("SUCCESS"); } catch (e) { res.send(e.message); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
