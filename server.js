const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (css, js, images)
app.use(express.static(__dirname));

// --- 1. THE FIX: Force Serve index.html ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 

function formatMessage(sender, text) {
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `**${sender}**: ${text} [${time}]`;
}

function broadcastUserList() {
    io.emit('user-list-update', Object.values(users));
}

function broadcastVCUserList() {
    io.emit('vc-user-list-update', Object.values(vcUsers));
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Join Chat
    socket.on('set-username', (data) => {
        users[socket.id] = { id: socket.id, username: data.username, avatar: data.avatar };
        const joinMsg = formatMessage('System', `User '${data.username}' joined.`);
        
        messageHistory.push(joinMsg);
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
        
        socket.emit('history', messageHistory); 
        socket.broadcast.emit('chat-message', { text: joinMsg });
        broadcastUserList();
    });

    // Send Message
    socket.on('send-message', (text) => {
        const user = users[socket.id];
        if (user) {
            const formatted = formatMessage(user.username, text);
            io.emit('chat-message', { text: formatted, avatar: user.avatar });
            messageHistory.push(formatted);
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
        }
    });

    // Voice Chat Logic
    socket.on('join-vc', () => {
        const user = users[socket.id];
        if (user) {
            vcUsers[socket.id] = { ...user, isMuted: false };
            broadcastVCUserList();
            socket.broadcast.emit('vc-user-joined', { id: socket.id });
            io.emit('chat-message', { text: formatMessage('System', `**${user.username}** joined Voice Chat.`) });
        }
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            const name = vcUsers[socket.id].username;
            delete vcUsers[socket.id];
            broadcastVCUserList();
            socket.broadcast.emit('vc-user-left', { id: socket.id });
            io.emit('chat-message', { text: formatMessage('System', `**${name}** left Voice Chat.`) });
        }
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });

    // WebRTC Signaling
    socket.on('voice-offer', (data) => {
        io.to(data.to).emit('voice-offer', { from: socket.id, offer: data.offer });
    });

    socket.on('voice-answer', (data) => {
        io.to(data.to).emit('voice-answer', { from: socket.id, answer: data.answer });
    });

    socket.on('voice-candidate', (data) => {
        io.to(data.to).emit('voice-candidate', { from: socket.id, candidate: data.candidate });
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (users[socket.id]) {
            const name = users[socket.id].username;
            delete users[socket.id];
            
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList();
                socket.broadcast.emit('vc-user-left', { id: socket.id });
            }

            broadcastUserList();
            const msg = formatMessage('System', `User '${name}' left.`);
            io.emit('chat-message', { text: msg });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
