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

const ADMIN_USERNAME = 'kl_'; 

// --- Utility Functions ---
function formatMessage(sender, text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (sender === 'System' || sender === 'Announcement') {
        return `**${sender}** ${text} [${time}]`;
    }
    return `**${sender}**: ${text} [${time}]`;
}

function broadcastUserList() {
    io.emit('user-list-update', Object.values(users));
}

function broadcastVCUserList() {
    io.emit('vc-user-list-update', Object.values(vcUsers));
}

function addToHistory(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send initial state
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
            const errorMsg = formatMessage('System', `The username '${username}' is already taken.`);
            socket.emit('chat-message', { text: errorMsg, avatar: null });
            return;
        }

        users[socket.id] = { username, avatar: newAvatar, id: socket.id };

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }
        
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
            io.emit('chat-message', { text: joinMsg, avatar: null });
            addToHistory(joinMsg);
        }
        
        broadcastUserList();
    });

    // --- 2. Chat Messages ---
    socket.on('chat-message', (msg) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;

        if (typeof msg === 'string' && msg.startsWith('/')) {
            const parts = msg.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' '); 
            
            let response = '';

            if (command === 'msg') {
                const targetUsername = parts[1];
                const privateMessage = parts.slice(2).join(' ').trim();
                
                if (!targetUsername || !privateMessage) {
                    response = `Usage: /msg <username> <message>`;
                } else {
                    const recipientId = Object.keys(users).find(id => users[id].username.toLowerCase() === targetUsername.toLowerCase());
                    if (!recipientId) response = `User '${targetUsername}' not found.`;
                    else {
                        const sentMsg = formatMessage('System', `**[PM to ${targetUsername}]**: **${privateMessage}**`);
                        socket.emit('chat-message', { text: sentMsg, avatar: null });
                        const receivedMsg = formatMessage('System', `**[PM from ${sender}]**: **${privateMessage}**`);
                        io.to(recipientId).emit('chat-message', { text: receivedMsg, avatar: null });
                        return;
                    }
                }
            } else if (sender === ADMIN_USERNAME) {
                if (command === 'server' && args) {
                    const serverMsg = formatMessage('Announcement', `: **${args}**`);
                    io.emit('chat-message', { text: serverMsg, avatar: null });
                    addToHistory(serverMsg);
                    return; 
                } else if (command === 'clear') {
                    io.emit('clear-chat'); 
                    messageHistory.length = 0; 
                    const clearMsg = formatMessage('System', `Chat history cleared.`);
                    io.emit('chat-message', { text: clearMsg, avatar: null });
                    addToHistory(clearMsg);
                    return; 
                }
            } else {
                response = `Unknown command: /${command}`;
            }

            if (response) socket.emit('chat-message', { text: formatMessage('System', response), avatar: null });

        } else if (msg && msg.trim()) {
            const formattedMsg = formatMessage(sender, msg);
            io.emit('chat-message', { text: formattedMsg, avatar: userData.avatar, sender: sender });
            addToHistory(formattedMsg);
        }
    });

    // --- 3. Voice Chat & Signaling (UPDATED) ---
    socket.on('vc-join', (isJoining) => {
        const userData = users[socket.id];
        if (!userData) return;

        if (isJoining) {
            vcUsers[socket.id] = { 
                username: userData.username, 
                avatar: userData.avatar, 
                isMuted: false, 
                id: socket.id
            };
            const joinMsg = formatMessage('System', `**${userData.username}** joined Voice Chat.`);
            io.emit('chat-message', { text: joinMsg, avatar: null });
            addToHistory(joinMsg);
            
            // Broadcast to others so they can call this user
            socket.broadcast.emit('vc-user-joined', socket.id);
        } else {
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                const leaveMsg = formatMessage('System', `**${userData.username}** left Voice Chat.`);
                io.emit('chat-message', { text: leaveMsg, avatar: null });
                addToHistory(leaveMsg);
                
                // Tell others to hang up
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

    // THIS WAS MISSING: Handles the WebRTC Handshake
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
