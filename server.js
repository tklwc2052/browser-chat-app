const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose'); // NEW: Database tool

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- RENDER SPECIFIC FIX ---
app.set('trust proxy', 1); 

// --- DATABASE CONNECTION (NEW) ---
// Connect to MongoDB using the Environment Variable 'MONGO_URI'
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost/chatapp';

mongoose.connect(mongoURI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.log('❌ MongoDB Error:', err));

// --- Mongoose Schemas (Data Structure) ---
const msgSchema = new mongoose.Schema({
    text: String,
    sender: String,
    avatar: String,
    image: String,
    time: String,
    type: String,
    target: String, // For private messages
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', msgSchema);

const banSchema = new mongoose.Schema({
    ip: String,
    username: String,
    reason: String,
    bannedAt: { type: Date, default: Date.now }
});
const Ban = mongoose.model('Ban', banSchema);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
let messageHistory = []; // Now backed by DB
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 

// --- Admin State ---
const mutedUsers = new Set(); 
const bannedIPs = new Map();  
const bannedHistory = {};     

const ADMIN_USERNAME = 'kl_'; 

// --- INITIAL DATA LOAD ---
// Load bans and history from DB when server starts
async function loadData() {
    try {
        // 1. Load Bans
        const savedBans = await Ban.find({});
        savedBans.forEach(b => {
            bannedIPs.set(b.ip, b.username);
            bannedHistory[b.username.toLowerCase()] = b.ip;
        });
        console.log(`Loaded ${savedBans.length} bans.`);

        // 2. Load Last 50 Messages
        const savedMsgs = await Message.find({ type: { $ne: 'private' } }) // Don't load old PMs
            .sort({ timestamp: -1 })
            .limit(MAX_HISTORY);
        
        // Reverse so they are in chronological order (Oldest -> Newest)
        messageHistory = savedMsgs.reverse().map(m => ({
            text: m.text,
            sender: m.sender,
            avatar: m.avatar,
            image: m.image,
            time: m.time,
            type: m.type
        }));
        console.log(`Loaded ${messageHistory.length} messages.`);
    } catch (err) {
        console.error("Error loading data:", err);
    }
}
loadData();


// --- Utility Functions ---
function formatMessage(sender, text, avatar = null, image = null) {
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
        type: 'general'
    };
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

    // SAVE TO DB
    const newMsg = new Message({
        text: msgObj.text,
        sender: msgObj.sender,
        avatar: msgObj.avatar,
        image: msgObj.image,
        time: msgObj.time,
        type: msgObj.type,
        target: msgObj.target || null
    });
    newMsg.save().catch(err => console.error("Save Msg Error:", err));
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

io.on('connection', (socket) => {
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

    // --- 1. Set Username ---
    socket.on('set-username', ({ username, avatar }) => {
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
            
            // Standard /msg command
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
                    // Note: We are usually NOT saving private messages to global DB history
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
                    // CLEAR DB HISTORY
                    Message.deleteMany({})
                        .then(() => console.log("DB History Cleared"))
                        .catch(err => console.error(err));

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
                        if (targetId) {
                            io.to(targetId).emit('chat-message', formatMessage('System', 'You have been unmuted.'));
                        }

                        socket.emit('chat-message', formatMessage('System', `User ${targetName} unmuted.`));
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} is not muted.`));
                    }
                    return;

                } else if (command === 'kick') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /kick <username> [reason]'));
                    
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                        const kickMsg = formatMessage('System', `**${users[targetId].username}** was kicked. Reason: ${reason}`);
                        io.emit('chat-message', kickMsg);
                        io.sockets.sockets.get(targetId).disconnect(true);
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} not found.`));
                    }
                    return;

                } else if (command === 'ban') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /ban <username> [reason]'));
                    
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                        const targetSocket = io.sockets.sockets.get(targetId);
                        const targetIp = getClientIp(targetSocket);
                        const realName = users[targetId].username;

                        // UPDATE MEMORY
                        bannedIPs.set(targetIp, realName);
                        bannedHistory[realName.toLowerCase()] = targetIp; 
                        
                        // UPDATE DATABASE
                        const newBan = new Ban({ ip: targetIp, username: realName, reason: reason });
                        newBan.save().then(() => console.log(`Banned ${realName} in DB`));

                        const banMsg = formatMessage('System', `**${realName}** was BANNED. Reason: ${reason}`);
                        io.emit('chat-message', banMsg);
                        targetSocket.disconnect(true);
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} not found (must be online to ban).`));
                    }
                    return;

                } else if (command === 'unban') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /unban <username>'));
                    
                    const targetIp = bannedHistory[targetName.toLowerCase()];
                    
                    if (targetIp && bannedIPs.has(targetIp)) {
                        // REMOVE FROM MEMORY
                        bannedIPs.delete(targetIp);
                        
                        // REMOVE FROM DB
                        Ban.deleteOne({ ip: targetIp })
                           .then(() => console.log(`Unbanned ${targetName} in DB`));

                        socket.emit('chat-message', formatMessage('System', `Unbanned **${targetName}** (IP: ${targetIp})`));
                    } else {
                        // Fallback: Try to remove from DB by name even if not in memory cache
                         Ban.deleteOne({ username: targetName }).then((res) => {
                             if(res.deletedCount > 0) {
                                socket.emit('chat-message', formatMessage('System', `Unbanned **${targetName}** (Found in DB)`));
                             } else {
                                socket.emit('chat-message', formatMessage('System', `Could not find active ban for ${targetName}.`));
                             }
                         });
                    }
                    return;
                }

            } else if (msgText.startsWith('/server') || msgText.startsWith('/mute') || msgText.startsWith('/kick') || msgText.startsWith('/ban')) {
                socket.emit('chat-message', formatMessage('System', `You do not have permission to use this command.`));
                return;
            } else {
                socket.emit('chat-message', formatMessage('System', `Unknown command: /${command}`));
                return;
            }
        } 
        
        // --- NORMAL MESSAGE ---
        if (msgText.trim() || msgImage) {
            const currentAvatar = userAvatarCache[sender] || userData.avatar;
            const msgObj = formatMessage(sender, msgText, currentAvatar, msgImage);
            
            io.emit('chat-message', msgObj);
            addToHistory(msgObj);
        }
    });

    // --- 3. Voice Chat ---
    socket.on('vc-join', (isJoining) => {
        const userData = users[socket.id];
        if (!userData) return;

        if (mutedUsers.has(userData.username.toLowerCase())) {
            socket.emit('chat-message', formatMessage('System', 'You are muted and cannot join Voice Chat.'));
            return;
        }

        if (isJoining) {
            const bestAvatar = userAvatarCache[userData.username] || userData.avatar;
            vcUsers[socket.id] = { username: userData.username, avatar: bestAvatar, isMuted: false, id: socket.id };
            const joinMsg = formatMessage('System', `**${userData.username}** joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            socket.broadcast.emit('vc-user-joined', socket.id);
        } else {
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
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

    // --- 4. Typing Indicators ---
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
        if (users[socket.id]) {
            delete users[socket.id];
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id);
            }
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
