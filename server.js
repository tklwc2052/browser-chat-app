require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const { execSync } = require('child_process'); // NEW: Needed to talk to Git

const app = express();
const server = http.createServer(app);

// --- 1. AUTOMATIC GIT COMMIT MESSAGE FETCH ---
let SERVER_BUILD_DESC = "Server Update"; // Default fallback
let SERVER_BUILD_ID = Date.now(); 

try {
    // This command asks Git for the subject of the last commit
    const commitMessage = execSync('git log -1 --format=%s').toString().trim();
    if (commitMessage) {
        SERVER_BUILD_DESC = commitMessage;
        console.log(`✅ Loaded Update Message from Git: "${SERVER_BUILD_DESC}"`);
    }
} catch (e) {
    console.log("⚠️ Could not load Git message (running in non-git environment?). Using default.");
}

const io = socketIo(server, {
    maxHttpBufferSize: 1e7 
});

app.set('trust proxy', 1); 

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        
        // 1. LOAD PUBLIC HISTORY
        try {
            const savedMessages = await Message.find()
                .sort({ timestamp: -1 })
                .limit(MAX_HISTORY)
                .lean();
            messageHistory.push(...savedMessages.reverse());
            console.log(`Loaded ${savedMessages.length} past messages.`);
        } catch (err) {
            console.error("Error loading chat history:", err);
        }

        // 2. LOAD MOTD
        try {
            const savedMotd = await Config.findOne({ key: 'motd' });
            if (savedMotd) {
                serverMOTD = savedMotd.value;
                console.log(`Loaded MOTD: ${serverMOTD}`);
            }
        } catch (err) {
            console.error("Error loading MOTD:", err);
        }

        // 3. LOAD BANS
        try {
            const allBans = await Ban.find({});
            allBans.forEach(ban => {
                bannedIPs.set(ban.ip, true);
            });
            console.log(`Loaded ${allBans.length} active bans.`);
        } catch (err) {
            console.error("Error loading bans:", err);
        }
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    avatar: String,
    lastIp: String, 
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const banSchema = new mongoose.Schema({
    username: String,
    ip: String,
    bannedAt: { type: Date, default: Date.now },
    bannedBy: String
});
const Ban = mongoose.model('Ban', banSchema);

const messageSchema = new mongoose.Schema({
    id: String,
    sender: String,
    text: String,
    image: String,
    avatar: String,
    time: String,
    replyTo: Object,
    type: String, 
    isEdited: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});
messageSchema.index({ timestamp: -1 }); 
const Message = mongoose.model('Message', messageSchema);

const dmSchema = new mongoose.Schema({
    participants: [String], 
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

const configSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: String
});
const Config = mongoose.model('Config', configSchema);

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
            type: 'system',
            timestamp: now
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
        isEdited: false,
        timestamp: now
    };
}

async function savePublicMessage(msgObj) {
    if (msgObj.type === 'pm') return;
    try {
        const newMsg = new Message({
            id: msgObj.id,
            sender: msgObj.sender,
            text: msgObj.text,
            image: msgObj.image,
            avatar: msgObj.avatar,
            time: msgObj.time,
            replyTo: msgObj.replyTo,
            type: msgObj.type,
            isEdited: msgObj.isEdited || false,
            timestamp: msgObj.timestamp || new Date()
        });
        await newMsg.save();
    } catch (err) {
        console.error("Error saving public message:", err);
    }
}

function getDmKey(user1, user2) { return [user1, user2].sort(); }
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
            avatar: u.avatar,
            online: Object.values(users).some(live => live.username === u.username)
        }));
        io.emit('sidebar-user-list', sidebarList);
    } catch (err) { console.error("Sidebar update error", err); }
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', async (socket) => {
    
    // --- 2. SEND GIT COMMIT INFO TO CLIENT ---
    socket.emit('system-version-check', {
        id: SERVER_BUILD_ID,
        description: SERVER_BUILD_DESC
    });

    const clientIp = getClientIp(socket);
    
    if (bannedIPs.has(clientIp)) {
        socket.emit('chat-message', formatMessage('System', 'You are banned from this server.'));
        socket.disconnect(true);
        return;
    }

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
                { 
                    avatar: newAvatar, 
                    lastSeen: Date.now(),
                    lastIp: clientIp 
                },
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
            savePublicMessage(joinMsg); 
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

        if (msgText.startsWith('/')) {
            const parts = msgText.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1); 
            
            // --- PRIVATE MESSAGING ---
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
                        id: generateId(),
                        text: privateText,
                        type: 'private',
                        sender: sender,
                        target: users[recipientId].username,
                        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                        avatar: userAvatarCache[sender] || userData.avatar,
                        replyTo: replyTo
                    };
                    socket.emit('chat-message', pmObject);
                    io.to(recipientId).emit('chat-message', pmObject);
                }
                return; 
            } 
            
            // --- ADMIN COMMANDS ---
            if (sender === ADMIN_USERNAME) {
                const targetName = args[0];
                
                // 1. ANNOUNCEMENT
                if (command === 'server' && args.length > 0) {
                    const serverMsg = formatMessage('Announcement', `: **${args.join(' ')}**`);
                    io.emit('chat-message', serverMsg);
                    addToHistory(serverMsg);
                    savePublicMessage(serverMsg); 
                    return;
                } 
                
                // 2. MOTD
                else if (command === 'motd') {
                    const newMotd = args.join(' ');
                    if (newMotd) {
                        serverMOTD = newMotd;
                        io.emit('motd', serverMOTD);
                        io.emit('chat-message', formatMessage('System', `MOTD updated: ${newMotd}`));
                        try {
                            await Config.findOneAndUpdate({ key: 'motd' }, { value: newMotd }, { upsert: true });
                        } catch (e) { console.error("Error saving MOTD:", e); }
                    }
                    return;
                }

                // 3. PRUNE
                else if (command === 'prune') {
                    if (!targetName) {
                        socket.emit('chat-message', formatMessage('System', 'Usage: /prune <username> OR /prune ALL'));
                        return;
                    }

                    if (targetName === 'ALL') {
                        let kickCount = 0;
                        io.sockets.sockets.forEach((s) => {
                            // PROTECTION: Dont prune the admin
                            if (s.id !== socket.id) { 
                                s.emit('chat-message', formatMessage('System', 'The user list has been pruned. Please refresh.'));
                                s.disconnect(true);
                                kickCount++;
                            }
                        });
                        for (const key in users) { if (key !== socket.id) delete users[key]; }
                        io.emit('chat-message', formatMessage('System', `Pruned ${kickCount} active users.`));
                        broadcastSidebarRefresh();
                    
                    } else {
                        // SELF-PROTECTION
                        if (targetName === ADMIN_USERNAME) {
                            socket.emit('chat-message', formatMessage('System', '⚠️ You cannot prune yourself!'));
                            return;
                        }

                        // WIPE SPECIFIC USER
                        const targetSocketId = findSocketIdByUsername(targetName);
                        if (targetSocketId) {
                            const targetSocket = io.sockets.sockets.get(targetSocketId);
                            if (targetSocket) {
                                targetSocket.emit('chat-message', formatMessage('System', 'You have been pruned from the database.'));
                                targetSocket.disconnect(true);
                            }
                            delete users[targetSocketId]; 
                        }

                        try {
                            await User.deleteOne({ username: targetName });
                            await DM.deleteMany({ participants: targetName });
                            await Message.deleteMany({ sender: targetName });
                            io.emit('chat-message', formatMessage('System', `${targetName} was pruned and wiped from the DB.`));
                            broadcastSidebarRefresh();
                        } catch(err) {
                            socket.emit('chat-message', formatMessage('System', `Error pruning ${targetName}.`));
                        }
                    }
                    return;
                }

                // 4. BAN
                else if (command === 'ban') {
                    if (!targetName) {
                        socket.emit('chat-message', formatMessage('System', 'Usage: /ban <username>'));
                        return;
                    }

                    // SELF-PROTECTION
                    if (targetName === ADMIN_USERNAME) {
                        socket.emit('chat-message', formatMessage('System', '⚠️ CRITICAL: You cannot ban yourself!'));
                        return;
                    }

                    let ipToBan = null;
                    const targetSocketId = findSocketIdByUsername(targetName);
                    
                    if (targetSocketId) {
                        const targetSocket = io.sockets.sockets.get(targetSocketId);
                        ipToBan = getClientIp(targetSocket);
                        targetSocket.emit('chat-message', formatMessage('System', 'You have been BANNED.'));
                        targetSocket.disconnect(true);
                    } 
                    
                    if (!ipToBan) {
                        try {
                            const dbUser = await User.findOne({ username: targetName });
                            if (dbUser && dbUser.lastIp) ipToBan = dbUser.lastIp;
                        } catch (e) { console.error("Ban DB lookup error", e); }
                    }

                    if (ipToBan) {
                        bannedIPs.set(ipToBan, true);
                        try {
                            await Ban.create({ username: targetName.toLowerCase(), ip: ipToBan, bannedBy: sender });
                        } catch (e) { console.error("Error saving ban", e); }

                        io.emit('chat-message', formatMessage('System', `${targetName} has been BANNED.`));
                        console.log(`Banned ${targetName} IP: ${ipToBan}`);
                    } else {
                        socket.emit('chat-message', formatMessage('System', `Could not find IP for ${targetName}. Cannot ban.`));
                    }
                    return;
                }

                // 5. UNBAN
                else if (command === 'unban') {
                    if(!targetName) return;
                    try {
                        const banRecord = await Ban.findOne({ username: targetName.toLowerCase() });
                        if (banRecord) {
                            bannedIPs.delete(banRecord.ip);
                            await Ban.deleteOne({ _id: banRecord._id });
                            socket.emit('chat-message', formatMessage('System', `User ${targetName} (IP: ${banRecord.ip}) has been UNBANNED.`));
                        } else {
                            if (bannedIPs.has(targetName)) {
                                bannedIPs.delete(targetName);
                                socket.emit('chat-message', formatMessage('System', `IP ${targetName} unbanned manually.`));
                            } else {
                                socket.emit('chat-message', formatMessage('System', `No ban record found for "${targetName}".`));
                            }
                        }
                    } catch (e) {
                        console.error("Unban Error", e);
                        socket.emit('chat-message', formatMessage('System', "Database error during unban."));
                    }
                    return;
                }

                // 6. MUTE
                else if (command === 'mute') {
                    if (targetName === ADMIN_USERNAME) {
                        socket.emit('chat-message', formatMessage('System', 'You cannot mute yourself.'));
                        return;
                    }
                    if (targetName) {
                        mutedUsers.add(targetName.toLowerCase());
                        const muteMsg = formatMessage('System', `User ${targetName} has been muted.`);
                        io.emit('chat-message', muteMsg);
                        const targetSocketId = findSocketIdByUsername(targetName);
                        if(targetSocketId && vcUsers[targetSocketId]) {
                            vcUsers[targetSocketId].isMuted = true;
                            broadcastVCUserList();
                        }
                    }
                    return;
                }

                // 7. UNMUTE
                else if (command === 'unmute') {
                    if (targetName) {
                        mutedUsers.delete(targetName.toLowerCase());
                        const unmuteMsg = formatMessage('System', `User ${targetName} has been unmuted.`);
                        io.emit('chat-message', unmuteMsg);
                    }
                    return;
                }

                // 8. KICK
                else if (command === 'kick') {
                    if (targetName === ADMIN_USERNAME) {
                        socket.emit('chat-message', formatMessage('System', 'You cannot kick yourself.'));
                        return;
                    }
                    const targetSocketId = findSocketIdByUsername(targetName);
                    if (targetSocketId) {
                        const targetSocket = io.sockets.sockets.get(targetSocketId);
                        targetSocket.emit('chat-message', formatMessage('System', 'You have been kicked by an admin.'));
                        targetSocket.disconnect(true);
                        io.emit('chat-message', formatMessage('System', `${targetName} was kicked.`));
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} not found.`));
                    }
                    return;
                }

                // 9. CLEAR HISTORY
                else if (command === 'clear') {
                    messageHistory.length = 0;
                    await Message.deleteMany({}); 
                    io.emit('clear-chat');
                    const clearMsg = formatMessage('System', `Chat history cleared.`);
                    io.emit('chat-message', clearMsg);
                    addToHistory(clearMsg);
                    savePublicMessage(clearMsg);
                    return;
                }
            }
        }

        const msgObj = formatMessage(sender, msgText, userData.avatar, msgImage, false, replyTo);
        addToHistory(msgObj);
        savePublicMessage(msgObj); 
        io.emit('chat-message', msgObj);
    });

    socket.on('edit-message', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        const { id, newText } = data;

        const msgIndex = messageHistory.findIndex(m => m.id === id);
        if (msgIndex !== -1) {
            const msg = messageHistory[msgIndex];
            if (msg.sender === user.username || user.username === ADMIN_USERNAME) {
                msg.text = newText;
                msg.isEdited = true;
                io.emit('message-updated', { id, text: newText, isEdited: true });
                try {
                    await Message.findOneAndUpdate({ id: id }, { text: newText, isEdited: true });
                } catch(e) { console.error("Edit Public DB Error", e); }
            }
        }

        try {
            const dmDoc = await DM.findOne({ "messages.id": id });
            if (dmDoc) {
                const dbMsg = dmDoc.messages.find(m => m.id === id);
                if (dbMsg && (dbMsg.sender === user.username || user.username === ADMIN_USERNAME)) {
                    dbMsg.text = newText;
                    dbMsg.isEdited = true;
                    await dmDoc.save();
                    
                    const p1 = dmDoc.participants[0];
                    const p2 = dmDoc.participants[1];
                    const s1 = findSocketIdByUsername(p1);
                    const s2 = findSocketIdByUsername(p2);
                    if(s1) io.to(s1).emit('message-updated', { id, text: newText, isEdited: true });
                    if(s2) io.to(s2).emit('message-updated', { id, text: newText, isEdited: true });
                }
            }
        } catch(e) { console.error("Edit DM DB Error", e); }
    });

    socket.on('delete-message', async (id) => {
        const user = users[socket.id];
        if (!user) return;

        const msgIndex = messageHistory.findIndex(m => m.id === id);
        if (msgIndex !== -1) {
            const msg = messageHistory[msgIndex];
            if (msg.sender === user.username || user.username === ADMIN_USERNAME) {
                messageHistory.splice(msgIndex, 1);
                io.emit('message-deleted', id);
                try {
                    await Message.findOneAndDelete({ id: id });
                } catch(e) { console.error("Delete Public DB Error", e); }
            }
        }

        try {
            const dmDoc = await DM.findOne({ "messages.id": id });
            if (dmDoc) {
                const dbMsg = dmDoc.messages.find(m => m.id === id);
                if (dbMsg && (dbMsg.sender === user.username || user.username === ADMIN_USERNAME)) {
                    await DM.updateOne(
                        { _id: dmDoc._id },
                        { $pull: { messages: { id: id } } }
                    );
                    const p1 = dmDoc.participants[0];
                    const p2 = dmDoc.participants[1];
                    const s1 = findSocketIdByUsername(p1);
                    const s2 = findSocketIdByUsername(p2);
                    if(s1) io.to(s1).emit('message-deleted', id);
                    if(s2) io.to(s2).emit('message-deleted', id);
                }
            }
        } catch(e) { console.error("Delete DM DB Error", e); }
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
        
        const msgObj = formatMessage(sender.username, data.text, sender.avatar, data.image, true, data.replyTo);
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
        if (!target || target === 'global') socket.broadcast.emit('user-typing', { username: user.username, scope: 'global' });
        else {
            const targetSocketId = Object.keys(users).find(k => users[k].username === target);
            if(targetSocketId) io.to(targetSocketId).emit('user-typing', { username: user.username, scope: 'dm' });
        }
    });

    socket.on('typing-stop', (target) => {
        const user = users[socket.id];
        if(!user) return;
        if (!target || target === 'global') socket.broadcast.emit('user-stopped-typing', { username: user.username, scope: 'global' });
        else {
             const targetSocketId = Object.keys(users).find(k => users[k].username === target);
             if(targetSocketId) io.to(targetSocketId).emit('user-stopped-typing', { username: user.username, scope: 'dm' });
        }
    });

    socket.on('vc-join', () => {
        if (users[socket.id]) {
            vcUsers[socket.id] = { id: socket.id, username: users[socket.id].username, avatar: users[socket.id].avatar, isMuted: false };
            const joinMsg = formatMessage('System', `${users[socket.id].username} joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            savePublicMessage(joinMsg);
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
                savePublicMessage(leaveMsg);
                socket.broadcast.emit('vc-user-left', socket.id);
            }
        }
        broadcastVCUserList();
    });

    socket.on('vc-mute-toggle', (isMuted) => { if (vcUsers[socket.id]) { vcUsers[socket.id].isMuted = isMuted; broadcastVCUserList(); } });
    
    socket.on('signal', (data) => { io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal }); });
    
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            if (vcUsers[socket.id]) { delete vcUsers[socket.id]; broadcastVCUserList(); socket.broadcast.emit('vc-user-left', socket.id); }
            const leaveMsg = formatMessage('System', `${user.username} has left.`);
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            savePublicMessage(leaveMsg);
            io.emit('user-status-change', { username: user.username, online: false });
        }
    });
});

// --- EMERGENCY UNBAN ROUTE ---
app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try {
        await Ban.deleteMany({});
        bannedIPs.clear();
        res.send("<h1>SUCCESS!</h1><p>All bans have been deleted. You can go back to the chat now.</p>");
        console.log("EMERGENCY: All bans cleared via web route.");
    } catch (e) {
        res.send("Error: " + e.message);
    }
});

app.get('/admin', (req, res) => {
    res.redirect('https://www.youtube.com/watch?v=xvFZjo5PgG0');
});

app.get('/ip', (req, res) => {
    res.redirect('https://www.youtube.com/watch?v=VCrxUN8luzI');
});

// --- SNOW RIDER GAME ROUTE ---
app.get('/snowrider', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/snowrider.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
