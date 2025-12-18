const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- RENDER SPECIFIC FIX ---
// This tells Express to trust the load balancer (Render/Heroku)
// so we can see the real IP address of the user.
app.set('trust proxy', 1); 

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 

// --- Admin State ---
const mutedUsers = new Set(); // Stores usernames of muted people
const bannedIPs = new Map();  // Stores IP -> Username mapping
const bannedHistory = {};     // Helper to allow unbanning by username

const ADMIN_USERNAME = 'kl_'; 

// --- Utility Functions ---
function formatMessage(sender, text, avatar = null, image = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // Cache lookup for avatar
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
}

function findSocketIdByUsername(username) {
    return Object.keys(users).find(id => 
        users[id].username.toLowerCase() === username.toLowerCase()
    );
}

// Helper to safely get IP behind Render's proxy
function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
        // x-forwarded-for can be a list (e.g. "client, proxy1, proxy2"). We want the first one.
        return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address;
}

app.use(express.static('public'));

io.on('connection', (socket) => {
    // --- 0. Ban Check (Render Safe) ---
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

        // Prevent taking the Admin name if not authorized
        if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && oldUsername !== ADMIN_USERNAME) {
            // Note: In a real app, add password verification here.
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

        // Mute Check
        if (mutedUsers.has(sender)) {
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

                // --- NEW COMMANDS ---

                } else if (command === 'mute') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /mute <username> [reason]'));
                    
                    mutedUsers.add(targetName);
                    const muteMsg = formatMessage('System', `**${targetName}** was muted by Admin. Reason: ${reason}`);
                    io.emit('chat-message', muteMsg);
                    return;

                } else if (command === 'unmute') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /unmute <username>'));
                    
                    if (mutedUsers.has(targetName)) {
                        mutedUsers.delete(targetName);
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} unmuted.`));
                        io.to(findSocketIdByUsername(targetName)).emit('chat-message', formatMessage('System', 'You have been unmuted.'));
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} is not muted.`));
                    }
                    return;

                } else if (command === 'kick') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /kick <username> [reason]'));
                    
                    const targetId = findSocketIdByUsername(targetName);
                    if (targetId) {
                        const kickMsg = formatMessage('System', `**${targetName}** was kicked. Reason: ${reason}`);
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
                        
                        // RENDER FIX: Get IP from headers so we ban the real person, not the server proxy
                        const targetIp = getClientIp(targetSocket);
                        
                        bannedIPs.set(targetIp, targetName);
                        bannedHistory[targetName] = targetIp; 

                        const banMsg = formatMessage('System', `**${targetName}** was BANNED. Reason: ${reason}`);
                        io.emit('chat-message', banMsg);
                        targetSocket.disconnect(true);
                    } else {
                        socket.emit('chat-message', formatMessage('System', `User ${targetName} not found (must be online to ban).`));
                    }
                    return;

                } else if (command === 'unban') {
                    if (!targetName) return socket.emit('chat-message', formatMessage('System', 'Usage: /unban <username>'));
                    
                    const targetIp = bannedHistory[targetName];
                    if (targetIp && bannedIPs.has(targetIp)) {
                        bannedIPs.delete(targetIp);
                        socket.emit('chat-message', formatMessage('System', `Unbanned **${targetName}** (IP: ${targetIp})`));
                    } else {
                        socket.emit('chat-message', formatMessage('System', `Could not find active ban for ${targetName}.`));
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

        // Prevent VC join if banned or muted
        if (mutedUsers.has(userData.username)) {
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
