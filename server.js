const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const userAvatarCache = {}; 

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
        text: text, // Text caption (optional if image exists)
        image: image, // Base64 Image string (optional if text exists)
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

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.emit('history', messageHistory);
    broadcastUserList();
    broadcastVCUserList(); 

    // --- 1. Set Username ---
    socket.on('set-username', ({ username, avatar }) => {
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

        let msgText = '';
        let msgImage = null;

        // Support both old string messages and new object messages
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
            const args = parts.slice(1).join(' '); 
            
            if (command === 'msg') {
                const targetUsername = parts[1];
                const privateText = parts.slice(2).join(' ').trim();
                
                if (!targetUsername || !privateText) {
                    socket.emit('chat-message', formatMessage('System', `Usage: /msg <username> <message>`));
                    return;
                }

                const recipientId = Object.keys(users).find(id => 
                    users[id].username.toLowerCase() === targetUsername.toLowerCase()
                );

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
            
            if (sender === ADMIN_USERNAME) {
                if (command === 'server' && args) {
                    const serverMsg = formatMessage('Announcement', `: **${args}**`);
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
                }
            } else if (msgText.startsWith('/server') || msgText.startsWith('/clear')) {
                socket.emit('chat-message', formatMessage('System', `Unknown command.`));
                return;
            } else {
                socket.emit('chat-message', formatMessage('System', `Unknown command: /${command}`));
                return;
            }
        } 
        
        // --- NORMAL MESSAGE ---
        // Proceed if there is text OR an image
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
