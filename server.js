require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const fs = require('fs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

const app = express();
const server = http.createServer(app);

// --- 1. AUTOMATIC UPDATE MESSAGE ---
let SERVER_BUILD_DESC = "System Update"; 
const SERVER_BUILD_ID = Date.now(); 

try {
    if (fs.existsSync('build_desc.txt')) {
        SERVER_BUILD_DESC = fs.readFileSync('build_desc.txt', 'utf8').trim();
    }
} catch (e) {
    console.log("⚠️ build_desc.txt not found.");
}

// --- CLOUDINARY CONFIG ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

const io = socketIo(server, { maxHttpBufferSize: 1e7 });
app.set('trust proxy', 1); 

// --- MONGODB SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    displayName: String,
    avatar: String,
    lastIp: String,
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    sender: String,
    text: String,
    image: String,
    channel: { type: String, default: 'main' },
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chat')
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.log(err));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- NEW UPLOAD ROUTE ---
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'chat_uploads' },
        (error, result) => {
            if (error) return res.status(500).json({ error: error.message });
            res.json({ url: result.secure_url });
        }
    );
    stream.Readable.from(req.file.buffer).pipe(uploadStream);
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('chat-message', async (data) => {
        const msg = new Message(data);
        await msg.save();
        io.to(data.channel || 'main').emit('chat-message', data);
    });

    socket.on('join', (room) => socket.join(room));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
