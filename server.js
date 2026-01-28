require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path'); 
const fs = require('fs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);

// --- CLOUDINARY CONFIG ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer config
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } 
});

const io = socketIo(server, { maxHttpBufferSize: 1e7 });

app.set('trust proxy', 1); 

// --- STATE VARIABLES ---
const users = {}; 
const vcUsers = {}; 
const activeScreenShares = new Set();
const disconnectTimeouts = {};

// --- NEW: MUSIC PLAYER STATE ---
let musicState = {
    currentVideoId: null, 
    title: null,
    isPlaying: false,
    startTime: 0,        
    seekPosition: 0,     
    queue: []            
};

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- SCHEMAS (Simplified for this file) ---
const userSchema = new mongoose.Schema({
    username: String,
    displayName: String,
    password: { type: String, select: false },
    avatar: String,
    banner: String,
    description: String,
    customBackground: String,
    lastSeen: Date,
    pronouns: String
});
const User = mongoose.model('User', userSchema);
const Ban = mongoose.model('Ban', new mongoose.Schema({ ip: String, reason: String }));

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ROUTES ---

// Upload Avatar
app.post('/upload-avatar', upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                { folder: 'chat_avatars' },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            const bufferStream = new require('stream').PassThrough();
            bufferStream.end(req.file.buffer);
            bufferStream.pipe(uploadStream);
        });
        res.json({ url: result.secure_url });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// The "Toast" Reset Route
app.get('/i-like-my-toast-with-butter', async (req, res) => {
    try { await Ban.deleteMany({}); res.send("SUCCESS: Bans cleared."); } catch (e) { res.send(e.message); }
});


// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // 1. MUSIC SYNC LOGIC (NEW) ==============================
    
    // Send current state to user immediately upon connection
    socket.emit('music-sync-state', {
        ...musicState,
        serverTime: Date.now()
    });

    socket.on('music-action', (action) => {
        // Broadcast actions to everyone else to keep them in sync
        switch (action.type) {
            case 'queue':
                musicState.queue.push(action.payload); // { videoId, title }
                io.emit('music-update-queue', musicState.queue);
                
                // If nothing is playing, start this track immediately
                if (!musicState.currentVideoId) {
                    startNextTrack();
                }
                break;

            case 'play':
                musicState.isPlaying = true;
                musicState.seekPosition = action.payload.currentTime;
                musicState.startTime = Date.now();
                // Tell everyone to play from this specific time
                io.emit('music-sync-play', { currentTime: musicState.seekPosition });
                break;

            case 'pause':
                musicState.isPlaying = false;
                musicState.seekPosition = action.payload.currentTime;
                io.emit('music-sync-pause', { currentTime: musicState.seekPosition });
                break;
                
            case 'next':
                startNextTrack();
                break;
        }
    });

    function startNextTrack() {
        if (musicState.queue.length > 0) {
            const next = musicState.queue.shift();
            musicState.currentVideoId = next.videoId;
            musicState.title = next.title;
            musicState.isPlaying = true;
            musicState.seekPosition = 0;
            musicState.startTime = Date.now();
            
            io.emit('music-start-track', { 
                videoId: next.videoId, 
                title: next.title 
            });
            io.emit('music-update-queue', musicState.queue);
        } else {
            // Queue finished
            musicState.currentVideoId = null;
            musicState.isPlaying = false;
            io.emit('music-stop');
        }
    }
    // ========================================================


    // 2. EXISTING CHAT & VOICE LOGIC
    socket.on('join', async (username) => {
        // ... (Assuming standard user join logic here) ...
        users[socket.id] = { username, id: socket.id };
        // Clear disconnect timeout if they reconnected fast
        if (disconnectTimeouts[username]) clearTimeout(disconnectTimeouts[username]);
    });

    socket.on('join-vc', (user) => {
        vcUsers[socket.id] = user;
        io.emit('vc-user-list', Object.values(vcUsers));
    });

    socket.on('leave-vc', () => {
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list', Object.values(vcUsers));
        }
    });

    // WebRTC Signaling
    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', {
            signal: data.signal,
            sender: socket.id
        });
    });

    socket.on('disconnect', () => {
        // Handle VC Disconnect
        if (vcUsers[socket.id]) {
            delete vcUsers[socket.id];
            io.emit('vc-user-list', Object.values(vcUsers));
        }
        
        // Handle User Disconnect with Timeout
        const user = users[socket.id];
        if (user) {
            disconnectTimeouts[user.username] = setTimeout(() => {
                // Perform final cleanup if they haven't reconnected
                delete users[socket.id];
            }, 2000);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
