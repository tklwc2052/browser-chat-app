const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

// --- CRITICAL FIX FOR RENDER/PRODUCTION DEPLOYMENT ---
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});


// --- State Management ---
const users = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const vcParticipants = {}; 

const ADMIN_USERNAME = 'kl_';

// --- Utility Functions ---

/**
 * Creates a structured message object for broadcast and history.
 * @param {string} sender - The sender's name.
 * @param {string} content - The message text or Data URL.
 * @param {string} type - 'text', 'image', 'system', 'announcement', 'pm_to', 'pm_from'.
 * @param {string} target - For 'pm' type, the recipient's username.
 * @returns {object} The structured message object.
 */
function createMessage(sender, content, type = 'text', target = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // Create a unique-enough ID for this session (for history/grouping)
    const id = `${Date.now()}-${Math.floor(Math.random() * 99999)}`; 

    const message = {
        id: id,
        sender: sender,
        content: content,
        type: type,
        time: time,
        target: target 
    };
    return message;
}

/**
 * Sends the current list of online users to all connected clients.
 */
function broadcastUserList() {
    const onlineUsernames = Object.values(users);
    io.emit('user-list-update', onlineUsernames);
}

/**
 * Sends the current list of voice chat participants to all connected clients.
 */
function broadcastVcUserList() {
    const onlineUsernames = Object.values(users);
    io.emit('user-list-update', onlineUsernames);
}

/**
 * Adds a message object to history and truncates it if necessary.
 * @param {object} msg - The structured message object.
 */
function addToHistory(msg) {
    messageHistory.push(msg);
    if (messageHistory.length > MAX_HISTORY) {
        messageHistory.shift(); 
    }
}

// --- Serve Static Files ---
app.use(express.static('public'));

// --- Socket.IO Connection Handler ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send the structured message history
    socket.emit('history', messageHistory);
    broadcastVcUserList(); 

    // --- 1. Set Username ---
    socket.on('set-username', (username) => {
        const oldUsername = users[socket.id];

        if (!username || username === oldUsername) {
            return;
        }

        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.values(users).some(name => name.toLowerCase() === usernameLower);

        if (isDuplicate) {
            const errorMsg = createMessage('System', `The username '${username}' is already taken. Please choose another.`, 'system');
            socket.emit('chat-message', errorMsg);
            return;
        }

        users[socket.id] = username;
        console.log(`Username set for ${socket.id}: ${username}`);
        
        const joinMsg = createMessage('System', `User '${username}' joined the chat.`, 'system');
        io.emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        
        broadcastUserList();
    });

    // --- 2. Handle Chat Messages (Now accepts raw text) ---
    socket.on('chat-message', (rawText) => {
        const sender = users[socket.id] || 'Anonymous';
        const senderId = socket.id;
        const msg = rawText.trim();

        // Check if the message is a command
        if (msg.startsWith('/')) {
            const parts = msg.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' '); 
            
            let response = '';

            // --- 1. GENERAL COMMANDS (e.g., /msg) ---
            if (command === 'msg') {
                const targetUsername = parts[1];
                const privateMessage = parts.slice(2).join(' ').trim();
                
                if (!targetUsername || !privateMessage) {
                    response = `Usage: /msg <username> <message>. This message is private and not logged.`;
                } else {
                    const recipientId = Object.keys(users).find(id => users[id].toLowerCase() === targetUsername.toLowerCase());

                    if (!recipientId) {
                        response = `User '${targetUsername}' not found or not online.`;
                    } else if (recipientId === senderId) {
                        response = `You cannot send a private message to yourself.`;
                    } else {
                        // 1. Send to Sender (Confirmation)
                        const sentMsg = createMessage(sender, privateMessage, 'pm_to', targetUsername);
                        socket.emit('chat-message', sentMsg);

                        // 2. Send to Receiver (Actual PM)
                        const receivedMsg = createMessage(targetUsername, privateMessage, 'pm_from', sender);
                        io.to(recipientId).emit('chat-message', receivedMsg);
                        
                        return; 
                    }
                }
            } 
            
            // --- 2. ADMIN COMMANDS (kl_ only) ---
            else if (sender === ADMIN_USERNAME) {
                switch (command) {
                    case 'server':
                        if (args) {
                            const serverMsg = createMessage('Announcement', args, 'announcement');
                            io.emit('chat-message', serverMsg);
                            addToHistory(serverMsg);
                            return; 
                        } else {
                            response = `Usage: /server [message]. Broadcasts a server-wide announcement.`;
                        }
                        break;

                    case 'clear':
                        io.emit('clear-chat'); 
                        messageHistory.length = 0; 
                        const clearConfirmationMsg = createMessage('System', `Chat history cleared by admin (${sender}).`, 'system');
                        io.emit('chat-message', clearConfirmationMsg);
                        addToHistory(clearConfirmationMsg);
                        return; 
                    
                    default:
                        response = `Unknown Admin Command: /${command}. Available: /server, /clear.`;
                }
            } else {
                response = `Unknown command: /${command}. Only the /msg command is generally available.`;
            }

            if (response) {
                const commandResponse = createMessage('System', response, 'system');
                socket.emit('chat-message', commandResponse);
            }

        } else if (msg) {
            // Not a command, broadcast the text message
            const formattedMsg = createMessage(sender, msg, 'text');
            io.emit('chat-message', formattedMsg);
            addToHistory(formattedMsg);
        }
    });

    // --- NEW: 2b. Handle Incoming Media Messages ---
    socket.on('send-media', (mediaObject) => {
        const sender = users[socket.id] || 'Anonymous';
        
        // mediaObject.content is the Data URL string
        if (mediaObject && mediaObject.type === 'image' && mediaObject.content) {
            const imageMsg = createMessage(sender, mediaObject.content, 'image'); 
            
            io.emit('chat-message', imageMsg);
            addToHistory(imageMsg);
        }
    });
    
    // --- 3. Handle Voice Chat Join/Leave ---

    socket.on('vc-join', () => {
        const username = users[socket.id];
        if (username && !vcParticipants[socket.id]) {
            vcParticipants[socket.id] = username;
            
            const joinMsg = createMessage('System', `User '${username}' joined the voice chat.`, 'system');
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            
            broadcastVcUserList();
            
            socket.broadcast.emit('vc-user-joined', socket.id, username);
        }
    });

    socket.on('vc-leave', () => {
        const username = users[socket.id];
        if (username && vcParticipants[socket.id]) {
            delete vcParticipants[socket.id];

            const leaveMsg = createMessage('System', `User '${username}' left the voice chat.`, 'system');
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            
            broadcastVcUserList();
            
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    // --- 4. WebRTC Signaling ---
    socket.on('webrtc-signal', (toId, signal) => {
        io.to(toId).emit('webrtc-signal', socket.id, signal);
    });


    // --- 5. Handle Disconnect ---
    socket.on('disconnect', () => {
        const username = users[socket.id];
        
        // VC Cleanup
        if (vcParticipants[socket.id]) {
            delete vcParticipants[socket.id];
            broadcastVcUserList();
            socket.broadcast.emit('vc-user-left', socket.id); 
        }

        if (username) {
            delete users[socket.id];
            console.log(`User disconnected: ${username} (${socket.id})`);
            
            const leaveMsg = createMessage('System', `User '${username}' left the chat.`, 'system');
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            
            broadcastUserList();
        } else {
            console.log(`Anonymous user disconnected: ${socket.id}`);
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
