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
// Users now store objects: { username, avatarURL }
const users = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 
const vcParticipants = {}; // Stores { socketId: { username, avatarURL } }

const ADMIN_USERNAME = 'kl_';
// Default placeholder avatar (Blue background, white text 'U')
const DEFAULT_AVATAR_URL = 'https://via.placeholder.com/30/007acc/ffffff?text=U'; 


// --- Utility Functions ---

/**
 * Creates a structured message object for broadcast and history.
 * @param {string} sender - The sender's name.
 * @param {string} senderAvatar - The sender's avatar URL.
 * @param {string} content - The message text or Data URL.
 * @param {string} type - 'text', 'image', 'image_with_caption', 'system', 'announcement', 'pm_to', 'pm_from'.
 * @param {string} target - For 'pm' type, the recipient's username.
 * @param {string} caption - The optional caption text for image messages.
 * @returns {object} The structured message object.
 */
function createMessage(sender, senderAvatar, content, type = 'text', target = null, caption = null) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    const id = `${Date.now()}-${Math.floor(Math.random() * 99999)}`; 

    const message = {
        id: id,
        sender: sender,
        senderAvatar: senderAvatar,
        content: content,
        type: type,
        time: time,
        target: target,
        caption: caption
    };
    return message;
}

/**
 * Sends the current list of online users to all connected clients.
 */
function broadcastUserList() {
    // Send objects: { username, avatarURL }
    const onlineUsersData = Object.values(users);
    io.emit('user-list-update', onlineUsersData);
}

/**
 * Sends the current list of voice chat participants to all connected clients.
 */
function broadcastVcUserList() {
    // Send objects: { username, avatarURL }
    io.emit('vc-user-list-update', Object.values(vcParticipants));
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
    broadcastUserList();

    // --- 1. Set Username (UPDATED) ---
    // Now receives an object { username, avatarDataUrl }
    socket.on('set-username', (data) => {
        const username = data.username;
        const customAvatar = data.avatarDataUrl; // Base64 URL from client
        
        const oldUserData = users[socket.id];

        if (!username || (oldUserData && username === oldUserData.username && customAvatar === oldUserData.avatarURL)) {
            return;
        }

        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.values(users).some(userData => userData.username.toLowerCase() === usernameLower);

        if (isDuplicate) {
            const errorMsg = createMessage('System', null, `The username '${username}' is already taken. Please choose another.`, 'system');
            socket.emit('chat-message', errorMsg);
            return;
        }
        
        // Use custom avatar if provided and valid, otherwise fall back to default
        const avatarURL = customAvatar && customAvatar.startsWith('data:image/') ? customAvatar : DEFAULT_AVATAR_URL; 
        const newUserData = { username: username, avatarURL: avatarURL };

        users[socket.id] = newUserData;
        console.log(`Username set for ${socket.id}: ${username}`);
        
        const joinMsg = createMessage('System', null, `User '${username}' joined the chat.`, 'system');
        io.emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        
        broadcastUserList();
    });

    // --- 2. Handle Chat Messages ---
    socket.on('chat-message', (rawText) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatarURL: DEFAULT_AVATAR_URL };
        const sender = userData.username;
        const senderAvatar = userData.avatarURL;
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
                    const recipientId = Object.keys(users).find(id => users[id].username.toLowerCase() === targetUsername.toLowerCase());

                    if (!recipientId) {
                        response = `User '${targetUsername}' not found or not online.`;
                    } else if (recipientId === senderId) {
                        response = `You cannot send a private message to yourself.`;
                    } else {
                        // 1. Send to Sender (Confirmation)
                        const sentMsg = createMessage(sender, senderAvatar, privateMessage, 'pm_to', targetUsername);
                        socket.emit('chat-message', sentMsg);

                        // 2. Send to Receiver (Actual PM)
                        const receivedMsg = createMessage(targetUsername, users[recipientId].avatarURL, privateMessage, 'pm_from', sender);
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
                            const serverMsg = createMessage('Announcement', null, args, 'announcement');
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
                        const clearConfirmationMsg = createMessage('System', null, `Chat history cleared by admin (${sender}).`, 'system');
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
                const commandResponse = createMessage('System', null, response, 'system');
                socket.emit('chat-message', commandResponse);
            }

        } else if (msg) {
            // Not a command, broadcast the text message
            const formattedMsg = createMessage(sender, senderAvatar, msg, 'text');
            io.emit('chat-message', formattedMsg);
            addToHistory(formattedMsg);
        }
    });

    // --- 2b. Handle Incoming Media Messages ---
    socket.on('send-media', (mediaObject) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatarURL: DEFAULT_AVATAR_URL };
        const sender = userData.username;
        const senderAvatar = userData.avatarURL;
        
        if (mediaObject && mediaObject.type === 'image' && mediaObject.content) {
            
            const type = mediaObject.text && mediaObject.text.trim() ? 'image_with_caption' : 'image';
            const caption = type === 'image_with_caption' ? mediaObject.text.trim() : null;

            const imageMsg = createMessage(sender, senderAvatar, mediaObject.content, type, null, caption); 
            
            io.emit('chat-message', imageMsg);
            addToHistory(imageMsg);
        }
    });
    
    // --- 3. Handle Voice Chat Join/Leave ---

    socket.on('vc-join', () => {
        const userData = users[socket.id];
        if (userData && !vcParticipants[socket.id]) {
            vcParticipants[socket.id] = userData;
            
            const joinMsg = createMessage('System', null, `User '${userData.username}' joined the voice chat.`, 'system');
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            
            broadcastVcUserList();
            
            socket.broadcast.emit('vc-user-joined', socket.id, userData.username);
        }
    });

    socket.on('vc-leave', () => {
        const userData = vcParticipants[socket.id];
        if (userData) {
            delete vcParticipants[socket.id];

            const leaveMsg = createMessage('System', null, `User '${userData.username}' left the voice chat.`, 'system');
            io.emit('chat-message', leaveMsg);
            addToHistory(leaveMsg);
            
            broadcastVcUserList();
            
            socket.broadcast.emit('vc-user-left', socket.id);
        }
    });

    // --- 4. WebRTC Signaling (Unchanged) ---
    socket.on('webrtc-signal', (toId, signal) => {
        io.to(toId).emit('webrtc-signal', socket.id, signal);
    });


    // --- 5. Handle Disconnect ---
    socket.on('disconnect', () => {
        const userData = users[socket.id];
        
        // VC Cleanup
        if (vcParticipants[socket.id]) {
            delete vcParticipants[socket.id];
            broadcastVcUserList();
            socket.broadcast.emit('vc-user-left', socket.id); 
        }

        if (userData) {
            delete users[socket.id];
            console.log(`User disconnected: ${userData.username} (${socket.id})`);
            
            const leaveMsg = createMessage('System', null, `User '${userData.username}' left the chat.`, 'system');
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
