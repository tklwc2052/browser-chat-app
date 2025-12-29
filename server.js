const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.static(path.join(__dirname, 'public')));

// --- 1. MongoDB Connection & Schema ---

// Connect to MongoDB using the Environment Variable
// This looks for "MONGO_URL" which you set in Render
mongoose.connect(process.env.MONGO_URL || process.env.DATABASE_URL)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Could not connect to MongoDB:', err));

// Define the shape of a Message
const messageSchema = new mongoose.Schema({
    msgId: String,          
    type: String,           // 'general' or 'pm'
    text: String,
    image: String,
    replyTo: Object,
    sender: String,
    target: String,         // For DMs: who is this for?
    avatar: String,
    time: String,           
    createdAt: { type: Date, default: Date.now } // For sorting
});

const Message = mongoose.model('Message', messageSchema);

// Keep "online users" in memory (RAM) because "online" is a temporary state
let users = {}; 

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

io.on('connection', (socket) => {
    // Default user state
    users[socket.id] = { username: null, avatar: null, online: true };

    // --- User Setup ---
    socket.on('set-username', (data) => {
        users[socket.id].username = data.username;
        users[socket.id].avatar = data.avatar;
        users[socket.id].online = true;
        socket.username = data.username;
        
        // Broadcast updated user list
        io.emit('sidebar-user-list', Object.values(users).filter(u => u.username));
    });

    // --- General Chat ---
    socket.on('chat-message', async (data) => {
        if (!socket.username) return;

        const msgData = {
            msgId: generateId(),
            type: 'general',
            text: data.text,
            image: data.image || null,
            replyTo: data.replyTo || null,
            sender: socket.username,
            avatar: users[socket.id].avatar,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        // 1. Save to MongoDB
        try {
            const newMsg = new Message(msgData);
            await newMsg.save();
        } catch (err) {
            console.error("Error saving message:", err);
        }

        // 2. Send to everyone
        io.emit('chat-message', { ...msgData, id: msgData.msgId });
    });

    // --- Fetch General History ---
    socket.on('get-history', async () => {
        try {
            // Fetch last 200 messages from DB
            const rawHistory = await Message.find({ type: 'general' })
                .sort({ createdAt: -1 }) // Get newest first
                .limit(200);
            
            // Reverse them so they show oldest -> newest
            const history = rawHistory.reverse().map(m => ({
                ...m.toObject(),
                id: m.msgId // Map internal msgId back to 'id' for frontend
            }));
            
            socket.emit('history', history);
        } catch (err) {
            console.error("Error fetching history:", err);
        }
    });

    // --- Direct Messages (DMs) ---
    socket.on('send-dm', async (data) => {
        if (!socket.username) return;

        const msgData = {
            msgId: generateId(),
            type: 'pm',
            text: data.text,
            image: data.image || null,
            replyTo: data.replyTo || null,
            sender: socket.username,
            target: data.target, // IMPORTANT: Save who this is for
            avatar: users[socket.id].avatar,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        // 1. Save to MongoDB
        try {
            const newMsg = new Message(msgData);
            await newMsg.save();
        } catch (err) {
            console.error("Error saving DM:", err);
        }

        // 2. Send to Sender and Receiver
        const payload = { from: socket.username, to: data.target, message: { ...msgData, id: msgData.msgId } };
        
        socket.emit('dm-received', payload);
        
        const targetSocketId = Object.keys(users).find(id => users[id].username === data.target);
        if (targetSocketId) {
            io.to(targetSocketId).emit('dm-received', payload);
        }
    });

    // --- Fetch DM History ---
    socket.on('fetch-dm-history', async (target) => {
        if (!socket.username) return;

        try {
            // Find messages where (Sender is Me AND Target is Them) OR (Sender is Them AND Target is Me)
            const rawMessages = await Message.find({
                type: 'pm',
                $or: [
                    { sender: socket.username, target: target },
                    { sender: target, target: socket.username }
                ]
            }).sort({ createdAt: 1 }); // Oldest to newest

            const messages = rawMessages.map(m => ({
                ...m.toObject(),
                id: m.msgId
            }));

            socket.emit('dm-history', { target, messages });
        } catch (err) {
            console.error("Error fetching DMs:", err);
        }
    });

    socket.on('delete-message', async (id) => {
        try {
            await Message.deleteOne({ msgId: id });
            io.emit('message-deleted', id);
        } catch (err) {
            console.error("Error deleting message:", err);
        }
    });

    // --- VC Signals ---
    socket.on('vc-join', () => { 
        io.emit('vc-user-list-update', Object.values(users).filter(u => u.online)); 
    }); 
    socket.on('vc-leave', () => {});
    
    socket.on('disconnect', () => {
        delete users[socket.id];
        io.emit('sidebar-user-list', Object.values(users).filter(u => u.username));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
