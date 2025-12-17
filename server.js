const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
const users = {}; 
const vcUsers = {}; // { socketId: { peerId: string, username: string, isMuted: boolean } }
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

    socket.emit('history', messageHistory);
    broadcastUserList();
    broadcastVCUserList(); 

    // --- Chat & User Logic ---
    socket.on('set-username', ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const newAvatar = avatar || 'placeholder-avatar.png'; 
        
        users[socket.id] = { username, avatar: newAvatar, id: socket.id };

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }
        
        if (users[socket.id].username !== oldUserData.username) {
            const joinMsg = formatMessage('System', `User '${username}' joined.`);
            io.emit('chat-message', { text: joinMsg, avatar: null });
            addToHistory(joinMsg);
        }
        broadcastUserList();
    });

    socket.on('chat-message', (msg) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        let messageContent = (typeof msg === 'object' && msg.text) ? msg.text : msg;
        
        if (messageContent.trim()) {
            const formattedMsg = formatMessage(userData.username, messageContent);
            io.emit('chat-message', { text: formattedMsg, avatar: userData.avatar, sender: userData.username });
            addToHistory(formattedMsg);
        }
    });

    // --- WEBRTC SIGNALING (The Magic Part) ---

    // When a user enters the VC
    socket.on('join-vc', (peerId) => {
        const userData = users[socket.id];
        if (!userData) return;

        vcUsers[socket.id] = {
            socketId: socket.id,
            peerId: peerId, // This is the "Phone Number" for WebRTC
            username: userData.username,
            avatar: userData.avatar,
            isMuted: false
        };

        // Tell everyone else: "Hey, this PeerID just joined, call them!"
        socket.broadcast.emit('user-connected', { peerId: peerId, socketId: socket.id });
        
        broadcastVCUserList();
        
        const systemMsg = formatMessage('System', `**${userData.username}** joined Voice Chat.`);
        io.emit('chat-message', { text: systemMsg, avatar: null });
    });

    socket.on('leave-vc', () => {
        const userData = vcUsers[socket.id];
        if (userData) {
            // Tell everyone else: "Hang up on this PeerID"
            socket.broadcast.emit('user-disconnected', userData.peerId);
            delete vcUsers[socket.id];
            broadcastVCUserList();
            
            const systemMsg = formatMessage('System', `**${userData.username}** left Voice Chat.`);
            io.emit('chat-message', { text: systemMsg, avatar: null });
        }
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            delete users[socket.id];
            if (vcUsers[socket.id]) {
                socket.broadcast.emit('user-disconnected', vcUsers[socket.id].peerId);
                delete vcUsers[socket.id];
            }
            broadcastUserList();
            broadcastVCUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
