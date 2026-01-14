require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

const app = express();
const server = http.createServer(app);

// --- MISSING LINE RESTORED HERE ---
const io = socketIo(server, { 
    maxHttpBufferSize: 1e8 // Allow larger packets for stability
});

// --- CLOUDINARY CONFIG ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.log('MongoDB Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    displayName: String,
    avatar: String,
    banner: { type: String, default: "" },
    customBackground: { type: String, default: "" },
    description: String, pronouns: String,
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    id: String, sender: String, senderDisplayName: String, 
    text: String, image: String, avatar: String, 
    time: String, replyTo: Object, type: String, 
    isEdited: { type: Boolean, default: false }, timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

// --- STATE ---
const users = {};
const vcUsers = {};
const messageHistory = [];
const userAvatarCache = {};

// --- UTILS ---
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function formatMessage(sender, text, avatar, image, isPm, replyTo, displayName) {
    return {
        id: generateId(),
        text, image, sender,
        senderDisplayName: displayName || sender,
        avatar: avatar || 'placeholder-avatar.png',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        replyTo,
        type: isPm ? 'pm' : 'general',
        isEdited: false
    };
}

app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const uploadStream = cloudinary.uploader.upload_stream({ folder: 'chat_assets', resource_type: 'auto' }, (error, result) => {
        if (error) return res.status(500).json({ error: error.message });
        res.json({ url: result.secure_url });
    });
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);
    bufferStream.pipe(uploadStream);
});

app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

io.on('connection', async (socket) => {
    // Send history only on load
    socket.emit('history', messageHistory);
    io.emit('vc-user-list-update', Object.values(vcUsers));

    // LOGIN
    socket.on('set-username', async ({ username }) => {
        if (!username) return;
        const dbUser = await User.findOne({ username }).lean();
        const displayName = dbUser ? (dbUser.displayName || username) : username;
        const avatar = dbUser ? (dbUser.avatar || 'placeholder-avatar.png') : 'placeholder-avatar.png';
        
        userAvatarCache[username] = avatar;
        users[socket.id] = { username, displayName, avatar, id: socket.id };
        
        if (dbUser) socket.emit('profile-info', dbUser);
        
        io.emit('user-status-change', { username, displayName, online: true, avatar });
        
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].displayName = displayName;
            vcUsers[socket.id].avatar = avatar;
            io.emit('vc-user-list-update', Object.values(vcUsers));
        }
    });

    // PROFILE
    socket.on('update-profile', async (data) => {
        const u = users[socket.id];
        if (!u) return;
        await User.findOneAndUpdate({ username: u.username }, data, { upsert: true });
        if (data.displayName) u.displayName = data.displayName;
        if (data.avatar) { u.avatar = data.avatar; userAvatarCache[u.username] = data.avatar; }
        io.emit('user-status-change', { username: u.username, displayName: u.displayName, online: true, avatar: u.avatar });
    });

    socket.on('get-user-profile', async (target) => {
        const dbUser = await User.findOne({ username: target }).lean();
        socket.emit('user-profile-data', dbUser || { notFound: true, username: target });
    });

    // --- MESSAGING ---
    socket.on('chat-message', async (payload) => {
        const user = users[socket.id];
        if (!user) return;

        let { text, image, replyTo, target } = typeof payload === 'object' ? payload : { text: payload };
        
        // --- DM LOGIC ---
        if (target && target !== 'null') {
            const recipientSocketId = Object.keys(users).find(id => users[id].username === target);
            
            const pm = formatMessage(user.username, text, user.avatar, image, true, replyTo, user.displayName);
            
            // Send to SENDER
            socket.emit('chat-message', pm);
            
            // Send to RECEIVER (if online)
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('chat-message', pm);
            }
            
            // CRITICAL: Return here so we don't save to public history
            return; 
        }

        // --- PUBLIC LOGIC ---
        const msg = formatMessage(user.username, text, user.avatar, image, false, replyTo, user.displayName);
        messageHistory.push(msg);
        if (messageHistory.length > 50) messageHistory.shift();
        
        io.emit('chat-message', msg);
        
        try { await new Message(msg).save(); } catch(e) { console.error(e); }
    });

    // --- EDIT / DELETE ---
    socket.on('delete-message', async (id) => {
        const idx = messageHistory.findIndex(m => m.id === id);
        if (idx !== -1 && messageHistory[idx].sender === users[socket.id].username) {
            messageHistory.splice(idx, 1);
            await Message.deleteOne({ id });
            io.emit('message-deleted', id);
        }
    });

    socket.on('edit-message', async ({ id, newText }) => {
        const msg = messageHistory.find(m => m.id === id);
        if (msg && msg.sender === users[socket.id].username) {
            msg.text = newText;
            msg.isEdited = true;
            await Message.updateOne({ id }, { text: newText, isEdited: true });
            io.emit('message-edited', { id, text: newText });
        }
    });

    // --- VOICE CHAT (SIGNALING) ---
    socket.on('join-vc', () => {
        const u = users[socket.id];
        if (u) {
            vcUsers[socket.id] = u;
            io.emit('vc-user-list-update', Object.values(vcUsers));
            // Tell everyone else "I am here, call me"
            socket.broadcast.emit('vc-user-joined', socket.id);
        }
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list-update', Object.values(vcUsers));
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    socket.on('signal', (data) => {
        // Pass the WebRTC signal to the specific target
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });

    socket.on('disconnect', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list-update', Object.values(vcUsers));
            socket.broadcast.emit('vc-user-left', socket.id);
        }
        delete users[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
