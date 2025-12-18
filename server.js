const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
const users = {}; 
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 

// --- CONFIGURATION ---
const ADMIN_USERNAME = 'kl_'; 

// --- Utility Functions ---
function formatMessage(sender, text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // Standard wrapper for normal/system messages
    if (sender === 'System' || sender === 'Announcement') {
        return {
            text: `**${sender}** ${text} [${time}]`, // Keep text format for system
            sender: sender,
            avatar: null,
            time: time,
            type: 'system'
        };
    }
    
    return {
        text: text,
        sender: sender,
        avatar: null, // Filled by route handler if available
        time: time,
        type: 'general'
    };
}

function broadcastUserList() {
    io.emit('user-list-update', Object.values(users));
}

function broadcastVCUserList() {
    io.emit('vc-user-list-update', Object.values(vcUsers));
}

function addToHistory(msgObj) {
    messageHistory.push(msgObj);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift(); 
}

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send history
    socket.emit('history', messageHistory);
    broadcastUserList();
    broadcastVCUserList(); 

    // --- 1. Set Username ---
    socket.on('set-username', ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        const newAvatar = avatar || 'placeholder-avatar.png'; 

        if (!username) return;

        const usernameLower = username.toLowerCase();
        // Check duplicate, ignoring self
        const isDuplicate = Object.keys(users).some(id => 
            id !== socket.id && users[id].username.toLowerCase() === usernameLower
        );

        if (isDuplicate) {
            const errorMsg = formatMessage('System', `The username '${username}' is already taken.`);
            socket.emit('chat-message', errorMsg);
            return;
        }

        users[socket.id] = { username, avatar: newAvatar, id: socket.id };

        // Sync VC profile if active
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }
        
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
        }
        
        broadcastUserList();
    });

    // --- 2. Chat Messages & Commands ---
    socket.on('chat-message', (msg) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;

        // Command Handling
        if (typeof msg === 'string' && msg.startsWith('/')) {
            const parts = msg.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' '); 
            
            // --- /MSG COMMAND (Private Message) ---
            if (command === 'msg') {
                const targetUsername = parts[1];
                const privateText = parts.slice(2).join(' ').trim();
                
                if (!targetUsername || !privateText) {
                    socket.emit('chat-message', formatMessage('System', `Usage: /msg <username> <message>`));
                    return;
                }

                const recipientId = Object.keys(users).find(id => 
                    users[id].username.toLowerCase() === targetUsername.toLowerCase()
                );

                if (!recipientId) {
                    socket.emit('chat-message', formatMessage('System', `User '${targetUsername}' not found.`));
                } else {
                    const now = new Date();
                    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

                    const pmObject = {
                        text: privateText,
                        type: 'private',
                        sender: sender,
                        target: users[recipientId].username,
                        time: time,
                        avatar: userData.avatar
                    };

                    // Send to Sender (So they see what they sent)
                    socket.emit('chat-message', pmObject);
                    // Send to Receiver
                    io.to(recipientId).emit('chat-message', pmObject);
                }
                return; // Stop execution here
            } 
            
            // --- ADMIN COMMANDS ---
            if (sender === ADMIN_USERNAME) {
                if (command === 'server' && args) {
                    const serverMsg = formatMessage('Announcement', `: **${args}**`);
                    io.emit('chat-message', serverMsg);
                    addToHistory(serverMsg);
                    return; 
                } 
                else if (command === 'clear') {
                    // 1. Clear Server History
                    messageHistory.length = 0; 
                    
                    // 2. Tell everyone to wipe their screens
                    io.emit('clear-chat'); 
                    
                    // 3. Send confirmation
                    const clearMsg = formatMessage('System', `Chat history cleared by admin.`);
                    io.emit('chat-message', clearMsg);
                    addToHistory(clearMsg);
                    return; 
                }
            } else if (msg.startsWith('/server') || msg.startsWith('/clear')) {
                socket.emit('chat-message', formatMessage('System', `Unknown command or permission denied.`));
                return;
            } else {
                socket.emit('chat-message', formatMessage('System', `Unknown command: /${command}`));
                return;
            }
        } 
        
        // Normal Message
        else if (msg && msg.trim()) {
            const msgObj = formatMessage(sender, msg);
            msgObj.avatar = userData.avatar;
            io.emit('chat-message', msgObj);
            addToHistory(msgObj);
        }
    });

    // --- 3. Voice Chat & Signaling ---
    socket.on('vc-join', (isJoining) => {
        const userData = users[socket.id];
        if (!userData) return;

        if (isJoining) {
            vcUsers[socket.id] = { 
                username: userData.username, 
                avatar: userData.avatar, 
                isMuted: false, 
                id: socket.id
            };
            const joinMsg = formatMessage('System', `**${userData.username}** joined Voice Chat.`);
            io.emit('chat-message', joinMsg);
            addToHistory(joinMsg);
            
            socket.broadcast.emit('vc-user-joined', socket.id);
        } else {
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                const leaveMsg = formatMessage('System', `**${userData.username}** left Voice Chat.`);
                io.emit('chat-message', leaveMsg);
                addToHistory(leaveMsg);
                
                socket.broadcast.emit('vc-user-left', socket.id);
            }
        }
        broadcastVCUserList();
    });

    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList();
        }
    });

    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            delete users[socket.id];
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList(); 
                socket.broadcast.emit('vc-user-left', socket.id);
            }
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
