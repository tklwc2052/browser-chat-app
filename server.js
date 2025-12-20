const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.static(path.join(__dirname, 'public')));

let history = []; 
let dmHistory = {}; 
let users = {}; 

// Simple ID Generator (No install needed)
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getDmKey(user1, user2) { return [user1, user2].sort().join('_'); }

io.on('connection', (socket) => {
    users[socket.id] = { username: null, avatar: null, online: true };

    socket.on('set-username', (data) => {
        users[socket.id].username = data.username;
        users[socket.id].avatar = data.avatar;
        users[socket.id].online = true;
        socket.username = data.username;
        io.emit('sidebar-user-list', Object.values(users).filter(u => u.username));
    });

    socket.on('chat-message', (data) => {
        if (!socket.username) return;
        const msg = {
            id: generateId(),
            type: 'general',
            text: data.text,
            image: data.image || null,
            replyTo: data.replyTo || null,
            sender: socket.username,
            avatar: users[socket.id].avatar,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        history.push(msg);
        if (history.length > 200) history.shift();
        io.emit('chat-message', msg);
    });

    socket.on('get-history', () => socket.emit('history', history));

    socket.on('send-dm', (data) => {
        if (!socket.username) return;
        const msg = {
            id: generateId(),
            type: 'pm',
            text: data.text,
            image: data.image || null,
            replyTo: data.replyTo || null,
            sender: socket.username,
            avatar: users[socket.id].avatar,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        const key = getDmKey(socket.username, data.target);
        if (!dmHistory[key]) dmHistory[key] = [];
        dmHistory[key].push(msg);
        
        socket.emit('dm-received', { from: socket.username, to: data.target, message: msg });
        const targetSocketId = Object.keys(users).find(id => users[id].username === data.target);
        if (targetSocketId) io.to(targetSocketId).emit('dm-received', { from: socket.username, to: data.target, message: msg });
    });

    socket.on('fetch-dm-history', (target) => {
        const key = getDmKey(socket.username, target);
        socket.emit('dm-history', { target, messages: dmHistory[key] || [] });
    });

    socket.on('delete-message', (id) => {
        // Simple delete for global history
        const idx = history.findIndex(m => m.id === id);
        if(idx !== -1) {
            history.splice(idx, 1);
            io.emit('message-deleted', id);
        }
    });

    // VC Signals
    socket.on('vc-join', () => { 
        io.emit('vc-user-list-update', Object.values(users).filter(u => u.online)); // Simplified
    }); 
    socket.on('vc-leave', () => {});
    
    socket.on('disconnect', () => {
        delete users[socket.id];
        io.emit('sidebar-user-list', Object.values(users).filter(u => u.username));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
