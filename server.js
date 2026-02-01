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
const crypto = require('crypto');
const session = require('express-session');

const app = express();
const server = http.createServer(app);

// --- 1. AUTOMATIC UPDATE MESSAGE ---
let SERVER_BUILD_DESC = "Auth System Added"; 
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
    limits: { fileSize: 5 * 1024 * 1024 } 
});

const io = socketIo(server, { maxHttpBufferSize: 1e7 });

app.set('trust proxy', 1); 
app.use(express.json());

// --- SESSION SETUP ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'cnc-corp-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// --- PASSWORD UTILS ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
    const [salt, hash] = storedValue.split(':');
    const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return hash === checkHash;
}

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/simplechat';
mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected');
        try {
            const savedMessages = await Message.find().sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
            messageHistory.push(...savedMessages.reverse());
        } catch (err) { console.error(err); }
    })
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    password: { type: String }, // NEW: Password field
    displayName: String, 
    description: { type: String, default: "" }, 
    pronouns: { type: String, default: "" },
    avatar: String,
    banner: { type: String, default: "" },           
    customBackground: { type: String, default: "" }, 
    lastIp: String, 
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    id: String, 
    sender: String, 
    senderDisplayName: String, 
    text: String, 
    image: String, 
    avatar: String, 
    time: String, 
    type: String, 
    channel: { type: String, default: 'main' },
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

// --- State Management ---
const users = {}; 
const messageHistory = []; 
const MAX_HISTORY = 20; 

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function formatMessage(sender, text, avatar = null, image = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return { id: generateId(), text, image, sender, avatar: avatar || 'placeholder-avatar.png', time, timestamp: now };
}

app.use(express.static(path.join(__dirname, 'public')));

// --- AUTH ROUTES ---
app.get('/auth/me', (req, res) => {
    if (req.session.username) {
        return res.json({ username: req.session.username });
    }
    res.status(401).send("Not logged in");
});

app.post('/auth/register', async (req, res) => {
    const { username, password, displayName } = req.body;
    if (!username || !password || !displayName) return res.status(400).send("Missing fields");

    try {
        const existing = await User.findOne({ username: username.toLowerCase() });
        if (existing) return res.status(400).send("Username taken");

        const newUser = new User({
            username: username.toLowerCase(),
            password: hashPassword(password),
            displayName: displayName,
            avatar: 'placeholder-avatar.png'
        });
        await newUser.save();
        
        // Auto-login after register
        req.session.username = newUser.username;
        res.send("Registered");
    } catch (e) {
        res.status(500).send("Error registering user");
    }
});

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username: username.toLowerCase() });
        if (user && verifyPassword(password, user.password)) {
            req.session.username = user.username;
            res.send("Logged In");
        } else {
            res.status(401).send("Invalid credentials");
        }
    } catch (e) {
        res.status(500).send("Server error");
    }
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy();
    res.send("Logged out");
});

// --- UPLOAD ROUTE ---
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const uploadStream = cloudinary.uploader.upload_stream({ folder: 'chat_assets' }, (error, result) => {
        if (error) return res.status(500).json({ error: error.message });
        res.json({ url: result.secure_url });
    });
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);
    bufferStream.pipe(uploadStream);
});

// --- SOCKET IO ---
io.on('connection', (socket) => {
    socket.emit('system-version-check', { id: SERVER_BUILD_ID, description: SERVER_BUILD_DESC });
    socket.emit('history', messageHistory);

    socket.on('set-username', async ({ username }) => {
        if (!username) return;
        // In this new version, we assume the user exists because they logged in
        let dbUser = await User.findOne({ username: username });
        if (!dbUser) {
            // Fallback for safety, though technically shouldn't happen with auth
            dbUser = { displayName: username, avatar: 'placeholder-avatar.png' };
        }
        users[socket.id] = { username, displayName: dbUser.displayName, avatar: dbUser.avatar };
        io.emit('chat-message', formatMessage('System', `${dbUser.displayName} joined the chat.`));
    });

    socket.on('chat-message', (payload) => {
        const user = users[socket.id];
        if (!user) return;
        const msg = formatMessage(user.username, payload.text, user.avatar, payload.image);
        messageHistory.push(msg);
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
        io.emit('chat-message', msg);
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            io.emit('chat-message', formatMessage('System', `${user.displayName} left the chat.`));
            delete users[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
