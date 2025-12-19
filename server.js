const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MONGO DB CONNECTION ---
// Paste your connection string here if it's different!
// mongoose.connect('YOUR_MONGODB_URI_HERE', { useNewUrlParser: true, useUnifiedTopology: true });

// Basic User Schema
const userSchema = new mongoose.Schema({
    username: String,
    avatar: String,
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

app.use(express.static(__dirname));

const users = {}; 
const vcUsers = {};
const userAvatarCache = {};
let history = []; 
const dmHistory = {}; 

function formatMessage(sender, text, type = 'general', image = null, avatar = null) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { sender, text, time, type, image, avatar };
}

function addToHistory(msg) {
    history.push(msg);
    if (history.length > 200) history.shift(); // Keep server memory clean
}

io.on('connection', (socket) => {
    
    // Send history on join
    socket.emit('history', history);
    socket.emit('sidebar-user-list', Object.values(users));
    socket.emit('vc-user-list-update', Object.values(vcUsers));

    // --- CRITICAL UPDATE: SET USERNAME WITH REGEX CHECK ---
    socket.on('set-username', async ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        const newAvatar = avatar || 'placeholder-avatar.png'; 

        if (!username) return;

        // 1. REGEX CHECK (The Police)
        // Only allows A-Z, 0-9, and Underscores. No spaces.
        const nameRegex = /^[a-zA-Z0-9_]+$/;

        if (!nameRegex.test(username)) {
            // Kick them back to the login screen
            socket.emit('force-reset', 'Your username has invalid characters (spaces/symbols). Please pick a new one.');
            return; // STOP. Do not save to DB.
        }

        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.keys(users).some(id => 
            id !== socket.id && users[id].username.toLowerCase() === usernameLower
        );

        if (isDuplicate) {
            socket.emit('chat-message', formatMessage('System', `The username '${username}' is already taken.`, 'system'));
            return;
        }

        userAvatarCache[username] = newAvatar;
        users[socket.id] = { username, avatar: newAvatar, id: socket.id, online: true };

        // Save to DB (Kept your logic)
        try {
            await User.findOneAndUpdate(
                { username: username },
                { avatar: newAvatar, lastSeen: Date.now() },
                { upsert: true, new: true }
            );
        } catch(e) { console.error("DB Save Error", e); }

        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            io.emit('vc-user-list-update', Object.values(vcUsers));
        }
        
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User ${username} joined the chat.`, 'system');
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
        }
        io.emit('sidebar-user-list', Object.values(users));
        io.emit('user-status-change', { username: username, online: true, avatar: newAvatar });
    });

    socket.on('chat-message', (data) => {
        const user = users[socket.id];
        if (user) {
            const msg = formatMessage(user.username, data.text, 'general', data.image, user.avatar);
            io.emit('chat-message', msg);
            addToHistory(msg);
        }
    });

    socket.on('send-dm', (data) => {
        const user = users[socket.id];
        if (!user) return;
        
        const targetSocketId = Object.keys(users).find(id => users[id].username === data.target);
        const msg = formatMessage(user.username, data.message, 'private', data.image, user.avatar);
        
        // Save to DM History (Memory only for now)
        if (!dmHistory[user.username]) dmHistory[user.username] = {};
        if (!dmHistory[user.username][data.target]) dmHistory[user.username][data.target] = [];
        dmHistory[user.username][data.target].push(msg);

        if (!dmHistory[data.target]) dmHistory[data.target] = {};
        if (!dmHistory[data.target][user.username]) dmHistory[data.target][user.username] = [];
        dmHistory[data.target][user.username].push(msg);

        // Send to Sender (so they see it)
        socket.emit('dm-received', { from: user.username, to: data.target, message: msg });
        
        // Send to Receiver
        if (targetSocketId) {
            io.to(targetSocketId).emit('dm-received', { from: user.username, to: data.target, message: msg });
        }
    });

    socket.on('fetch-dm-history', (targetUser) => {
        const user = users[socket.id];
        if(user && dmHistory[user.username] && dmHistory[user.username][targetUser]) {
            socket.emit('dm-history', { target: targetUser, messages: dmHistory[user.username][targetUser] });
        } else {
            socket.emit('dm-history', { target: targetUser, messages: [] });
        }
    });

    socket.on('typing-start', (scope) => {
        const user = users[socket.id];
        if (user) io.emit('user-typing', { username: user.username, scope });
    });
    
    socket.on('typing-stop', (scope) => {
        const user = users[socket.id];
        if (user) io.emit('user-stopped-typing', { username: user.username });
    });

    // --- VOICE CHAT LOGIC ---
    socket.on('vc-join', () => {
        const user = users[socket.id];
        if (user) {
            vcUsers[socket.id] = { ...user, isMuted: false };
            io.emit('vc-user-list-update', Object.values(vcUsers));
            io.emit('chat-message', formatMessage('System', `${user.username} joined Voice Chat.`, 'system'));
            
            // Tell everyone else to prepare a connection for this new user
            socket.broadcast.emit('vc-prepare-connection', socket.id);
        }
    });

    socket.on('vc-leave', () => {
        const user = users[socket.id];
        if (user && vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list-update', Object.values(vcUsers));
            io.emit('vc-user-left', socket.id); // Tell clients to remove audio element
        }
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            io.emit('vc-user-list-update', Object.values(vcUsers));
        }
    });

    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const leaveMsg = formatMessage('System', `User ${user.username} left the chat.`, 'system');
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            
            io.emit('user-status-change', { username: user.username, online: false });
            delete users[socket.id];
            
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                io.emit('vc-user-list-update', Object.values(vcUsers));
                io.emit('vc-user-left', socket.id);
            }
            io.emit('sidebar-user-list', Object.values(users));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
