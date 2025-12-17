const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
const users = {}; 
// vcUsers: { id: { username: string, avatar: string, isMuted: boolean, id: string } }
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 

// --- Configuration ---
const ADMIN_USERNAME = 'kl_'; // Designated Admin User (You!)

app.use(express.static(__dirname));

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
    const onlineUsers = Object.values(users);
    io.emit('user-list-update', onlineUsers);
}

function broadcastVCUserList() {
    const onlineVCUsers = Object.values(vcUsers);
    io.emit('vc-user-list-update', onlineVCUsers);
}

function addToHistory(message) {
    messageHistory.push(message);
    if (messageHistory.length > MAX_HISTORY) {
        messageHistory.shift();
    }
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // --- 1. User Join / Set Username ---
    socket.on('set-username', (data) => {
        const { username, avatar } = data;
        users[socket.id] = { 
            id: socket.id, 
            username: username, 
            avatar: avatar 
        };
        
        const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
        socket.emit('history', messageHistory); 
        socket.broadcast.emit('chat-message', { text: joinMsg, avatar: null });
        addToHistory(joinMsg);
        
        broadcastUserList();
    });

    // --- 2. Chat Messages ---
    socket.on('send-message', (messageText) => {
        const user = users[socket.id];
        if (user) {
            // Admin Commands
            if (user.username === ADMIN_USERNAME && messageText.startsWith('/')) {
                if (messageText === '/clear') {
                    messageHistory.length = 0; 
                    io.emit('clear-chat');
                    const sysMsg = formatMessage('System', 'Chat history cleared by Admin.');
                    io.emit('chat-message', { text: sysMsg, avatar: null });
                    return;
                }
            }

            const formattedMsg = formatMessage(user.username, messageText);
            const msgObject = { text: formattedMsg, avatar: user.avatar };
            io.emit('chat-message', msgObject);
            addToHistory(formattedMsg);
        }
    });

    // --- 3. Voice Chat Logic (UPDATED) ---

    socket.on('join-vc', () => {
        const userData = users[socket.id];
        if (userData) {
            vcUsers[socket.id] = { 
                ...userData, 
                isMuted: false 
            };
            
            // 1. Update the UI list for everyone
            broadcastVCUserList();

            // 2. Notify others to initiate a WebRTC call to this new user
            socket.broadcast.emit('vc-user-joined', { id: socket.id });

            const sysMsg = formatMessage('System', `**${userData.username}** joined Voice Chat.`);
            io.emit('chat-message', { text: sysMsg, avatar: null });
            addToHistory(sysMsg);
        }
    });

    socket.on('leave-vc', () => {
        const userData = users[socket.id];
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            
            // 1. Update UI list
            broadcastVCUserList();
            
            // 2. Notify others to cleanup the connection
            socket.broadcast.emit('vc-user-left', { id: socket.id });

            const leaveMsg = formatMessage('System', `**${userData.username}** left the Voice Chat.`);
            io.emit('chat-message', { text: leaveMsg, avatar: null });
            addToHistory(leaveMsg);
        }
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });

    // --- 4. WebRTC Signaling (NEW) ---
    // These events allow clients to exchange connection data via the server

    socket.on('voice-offer', (data) => {
        // data: { to: targetSocketId, offer: rtcOffer }
        io.to(data.to).emit('voice-offer', { from: socket.id, offer: data.offer });
    });

    socket.on('voice-answer', (data) => {
        // data: { to: targetSocketId, answer: rtcAnswer }
        io.to(data.to).emit('voice-answer', { from: socket.id, answer: data.answer });
    });

    socket.on('voice-candidate', (data) => {
        // data: { to: targetSocketId, candidate: rtcCandidate }
        io.to(data.to).emit('voice-candidate', { from: socket.id, candidate: data.candidate });
    });

    // --- 5. Handle Disconnect ---
    socket.on('disconnect', () => {
        const userData = users[socket.id];
        
        if (userData) {
            delete users[socket.id];
            
            // Remove from VC list on disconnect
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList(); 
                // Notify others to clean up WebRTC
                socket.broadcast.emit('vc-user-left', { id: socket.id });
            }
            
            const leaveMsg = formatMessage('System', `User '${userData.username}' left the chat.`);
            io.emit('chat-message', { text: leaveMsg, avatar: null }); 
            addToHistory(leaveMsg);
            
            broadcastUserList();
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
