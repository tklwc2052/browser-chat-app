const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 100 MB max for image uploads
});

app.use(express.static(path.join(__dirname, 'public')));

let history = []; 
let dmHistory = {}; // Format: { "user1_user2": [msg1, msg2] }
let users = {}; // { socketId: { username, avatar, online } }

// Helper to generate a consistent key for two users
function getDmKey(user1, user2) {
    return [user1, user2].sort().join('_');
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // Initialize user as anonymous initially
    users[socket.id] = { username: null, avatar: null, online: true };

    // Send global history immediately
    socket.emit('history', history);
    socket.emit('sidebar-user-list', Object.values(users).filter(u => u.username));

    // --- USER MANAGEMENT ---
    socket.on('set-username', (data) => {
        const oldName = users[socket.id].username;
        const newName = data.username;
        const avatar = data.avatar;

        // Check if name is taken by someone else
        const isTaken = Object.values(users).some(u => u.username === newName && u !== users[socket.id]);
        if (isTaken) {
            socket.emit('system-message', { text: 'Username is taken.' });
            return;
        }

        users[socket.id].username = newName;
        users[socket.id].avatar = avatar;
        users[socket.id].online = true;
        socket.username = newName; 

        // Notify everyone
        io.emit('sidebar-user-list', Object.values(users).filter(u => u.username));
        
        if (!oldName) {
            io.emit('chat-message', {
                type: 'system',
                text: `${newName} has joined the chat.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    });

    // --- GLOBAL CHAT ---
    socket.on('chat-message', (data) => {
        if (!socket.username) return;

        const msg = {
            id: uuidv4(),
            type: 'general',
            text: data.text,
            image: data.image || null,
            replyTo: data.replyTo || null, // Handle replies
            sender: socket.username,
            avatar: users[socket.id].avatar,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isEdited: false
        };

        history.push(msg);
        if (history.length > 200) history.shift();

        io.emit('chat-message', msg);
    });

    // --- DIRECT MESSAGES (The Fix is Here) ---
    socket.on('fetch-dm-history', (targetUser) => {
        if (!socket.username) return;
        const key = getDmKey(socket.username, targetUser);
        socket.emit('dm-history', { target: targetUser, messages: dmHistory[key] || [] });
    });

    socket.on('send-dm', (data) => {
        if (!socket.username) return;
        
        // Destructure carefully to match the client's payload
        const { target, text, image, replyTo } = data;

        const msg = {
            id: uuidv4(),
            type: 'pm', // "Private Message" type
            text: text,
            image: image || null,
            replyTo: replyTo || null,
            sender: socket.username,
            avatar: users[socket.id].avatar,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isEdited: false
        };

        const key = getDmKey(socket.username, target);
        if (!dmHistory[key]) dmHistory[key] = [];
        dmHistory[key].push(msg);
        if (dmHistory[key].length > 100) dmHistory[key].shift();

        // 1. Send to the sender (so they see it)
        socket.emit('dm-received', { from: socket.username, to: target, message: msg });

        // 2. Send to the target (find their socket ID)
        const targetSocketId = Object.keys(users).find(id => users[id].username === target);
        if (targetSocketId) {
            io.to(targetSocketId).emit('dm-received', { from: socket.username, to: target, message: msg });
        }
    });

    // --- MESSAGE ACTIONS (Edit/Delete) ---
    socket.on('edit-message', (data) => {
        // 1. Check Global History
        const globalMsg = history.find(m => m.id === data.id);
        if (globalMsg && (globalMsg.sender === socket.username || socket.username === 'kl_')) {
            globalMsg.text = data.newText;
            globalMsg.isEdited = true;
            io.emit('message-updated', { id: data.id, text: data.newText });
            return;
        }

        // 2. Check DM History (Expensive search, but necessary)
        for (let key in dmHistory) {
            const dmMsg = dmHistory[key].find(m => m.id === data.id);
            if (dmMsg && (dmMsg.sender === socket.username || socket.username === 'kl_')) {
                dmMsg.text = data.newText;
                dmMsg.isEdited = true;
                
                // Notify both participants
                const [user1, user2] = key.split('_');
                const u1Socket = Object.keys(users).find(id => users[id].username === user1);
                const u2Socket = Object.keys(users).find(id => users[id].username === user2);
                
                const updatePayload = { id: data.id, text: data.newText };
                if (u1Socket) io.to(u1Socket).emit('message-updated', updatePayload);
                if (u2Socket) io.to(u2Socket).emit('message-updated', updatePayload);
                return;
            }
        }
    });

    socket.on('delete-message', (id) => {
        // 1. Global
        const globalIdx = history.findIndex(m => m.id === id);
        if (globalIdx !== -1) {
            const msg = history[globalIdx];
            if (msg.sender === socket.username || socket.username === 'kl_') {
                history.splice(globalIdx, 1);
                io.emit('message-deleted', id);
                return;
            }
        }

        // 2. DMs
        for (let key in dmHistory) {
            const dmIdx = dmHistory[key].findIndex(m => m.id === id);
            if (dmIdx !== -1) {
                const msg = dmHistory[key][dmIdx];
                if (msg.sender === socket.username || socket.username === 'kl_') {
                    dmHistory[key].splice(dmIdx, 1);
                    
                    const [user1, user2] = key.split('_');
                    const u1Socket = Object.keys(users).find(k => users[k].username === user1);
                    const u2Socket = Object.keys(users).find(k => users[k].username === user2);
                    
                    if (u1Socket) io.to(u1Socket).emit('message-deleted', id);
                    if (u2Socket) io.to(u2Socket).emit('message-deleted', id);
                    return;
                }
            }
        }
    });

    // --- TYPING INDICATORS ---
    socket.on('typing-start', (scope) => {
        if (!socket.username) return;
        socket.broadcast.emit('user-typing', { username: socket.username, scope });
    });
    socket.on('typing-stop', (scope) => {
        if (!socket.username) return;
        socket.broadcast.emit('user-stopped-typing', { username: socket.username, scope });
    });

    // --- VOICE CHAT SIGNALS ---
    socket.on('vc-join', () => {
        if(!socket.username) return;
        // Notify others
        io.emit('chat-message', {
            type: 'system',
            text: `🔊 ${socket.username} joined Voice Chat`,
            time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
        });
        
        // Tell this user about existing users in VC (This is a naive implementation, 
        // normally we track who is in VC specifically, but here we just broadcast)
        const othersInVc = Object.values(users).filter(u => u.username !== socket.username && u.online); // Simplified
        // Realistically, you'd want a separate "inVC" list. 
        // For now, we rely on the client "join" button to trigger the handshake.
    });

    socket.on('vc-leave', () => {
        if(!socket.username) return;
        io.emit('vc-user-left', socket.id);
    });

    socket.on('signal', (data) => {
        // Relay WebRTC signals (offer, answer, candidate) to the specific target
        const targetSocketId = Object.keys(users).find(id => users[id].username === data.target); // Usually data.target is ID here?
        // Wait, in client we used ID for signaling. Let's fix that. 
        // The client code sends `target: initiatorId`.
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });
    
    // Naive VC Handshake Trigger
    socket.on('vc-join', () => {
         socket.broadcast.emit('vc-prepare-connection', socket.id);
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const user = users[socket.id];
        if (user && user.username) {
            user.online = false;
            io.emit('user-status-change', { username: user.username, online: false });
            io.emit('vc-user-left', socket.id);
        }
        delete users[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
