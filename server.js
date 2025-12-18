const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set('trust proxy', 1);

// --- FILE HUNTER ---
const possiblePaths = [__dirname, path.join(__dirname, 'public'), path.join(__dirname, 'src')];
let staticPath = __dirname;
for (let p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'index.html'))) {
        staticPath = p;
        break;
    }
}
app.use(express.static(staticPath));
app.get('/', (req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
});

// --- DATABASE ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost/chatapp';
mongoose.connect(mongoURI).then(() => console.log('✅ MongoDB Connected')).catch(err => console.log(err));

const Message = mongoose.model('Message', new mongoose.Schema({
    text: String, sender: String, avatar: String, image: String, time: String, type: String, target: String
}));
const Ban = mongoose.model('Ban', new mongoose.Schema({
    ip: String, username: String, reason: String
}));
const Whiteboard = mongoose.model('Whiteboard', new mongoose.Schema({
    _id: { type: String, default: 'main_board' },
    lines: { type: Array, default: [] } 
}));

const users = {};
const vcUsers = {};
const ADMIN_USERNAME = "kl_"; 

io.on('connection', async (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    const isBanned = await Ban.findOne({ ip: clientIp });
    if (isBanned) {
        socket.emit('banned', `Banned: ${isBanned.reason}`);
        socket.disconnect();
        return;
    }

    // Send Histories
    try {
        let board = await Whiteboard.findById('main_board');
        if (!board) board = await Whiteboard.create({ _id: 'main_board' });
        socket.emit('wb-history', board.lines);
    } catch (e) { console.log(e); }

    const history = await Message.find().sort({_id: -1}).limit(50);
    socket.emit('history', history.reverse());
    
    socket.emit('update-user-list', Object.values(users));
    io.emit('vc-user-list', Object.values(vcUsers));

    // Whiteboard
    socket.on('wb-draw', async (data) => {
        socket.broadcast.emit('wb-draw', data);
        await Whiteboard.findByIdAndUpdate('main_board', { $push: { lines: data } }, { upsert: true });
    });
    socket.on('wb-clear', async () => {
        await Whiteboard.findByIdAndUpdate('main_board', { lines: [] });
        io.emit('wb-redraw-all', []);
    });

    // Chat
    socket.on('join', (username) => {
        if (!username) return;
        users[socket.id] = { id: socket.id, username, avatar: 'default', isAdmin: username === ADMIN_USERNAME, ip: clientIp };
        io.emit('chat-message', { sender: 'System', text: `**${username}** joined.` });
        io.emit('room-users', { users: Object.values(users) });
    });

    socket.on('chat-message', async (msg) => {
        const user = users[socket.id];
        if (!user) return;
        if (msg.startsWith('/clear') && user.isAdmin) {
            await Message.deleteMany({});
            io.emit('clear-history');
            return;
        }
        const msgData = { sender: user.username, text: msg, avatar: user.avatar, time: new Date().toLocaleTimeString() };
        io.emit('chat-message', msgData);
        await new Message(msgData).save();
    });

    socket.on('typing-start', () => { if(users[socket.id]) socket.broadcast.emit('user-typing', users[socket.id].username); });
    socket.on('typing-stop', () => { if(users[socket.id]) socket.broadcast.emit('user-stopped-typing', users[socket.id].username); });
    
    socket.on('vc-join', () => { 
        if(users[socket.id]) { vcUsers[socket.id] = {...users[socket.id], isMuted: false}; io.emit('vc-user-list', Object.values(vcUsers)); }
    });
    socket.on('vc-leave', () => { 
        if(vcUsers[socket.id]) { delete vcUsers[socket.id]; io.emit('vc-user-list', Object.values(vcUsers)); }
    });

    socket.on('disconnect', () => {
        delete users[socket.id];
        delete vcUsers[socket.id];
        io.emit('room-users', { users: Object.values(users) });
        io.emit('vc-user-list', Object.values(vcUsers));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
