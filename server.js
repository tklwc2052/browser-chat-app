const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
// users: { id: { username: string, avatar: string, id: string } }
const users = {}; 
// vcUsers: { id: { username: string, avatar: string, isMuted: boolean, id: string } }
const vcUsers = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 

// --- Configuration ---
const ADMIN_USERNAME = 'kl_'; // Designated Admin User (You!)

// --- Utility Functions ---

/**
 * Formats a message string with username and timestamp.
 * @param {string} sender - The sender's name (or System/Announcement).
 * @param {string} text - The raw message content.
 * @returns {string} The formatted message string.
 */
function formatMessage(sender, text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    if (sender === 'System' || sender === 'Announcement') {
        return `**${sender}** ${text} [${time}]`;
    }
    return `**${sender}**: ${text} [${time}]`;
}

/**
 * Sends the current list of online users (for the main list) to all connected clients.
 */
function broadcastUserList() {
    const onlineUsers = Object.values(users);
    io.emit('user-list-update', onlineUsers);
}

/**
 * Sends the current list of users in the voice chat (for the VC panel) to all connected clients.
 */
function broadcastVCUserList() {
    const onlineVCUsers = Object.values(vcUsers);
    io.emit('vc-user-list-update', onlineVCUsers);
}

/**
 * Adds a message to history and truncates it if necessary.
 * @param {string} msg - The formatted message string.
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

    // Send the initial state
    socket.emit('history', messageHistory);
    broadcastUserList();
    broadcastVCUserList(); 

    // --- 1. Set Username & Avatar (Profile Update) ---
    socket.on('set-username', ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        const newAvatar = avatar || 'placeholder-avatar.png'; 

        if (!username) return;

        const usernameLower = username.toLowerCase();
        
        const isDuplicate = Object.keys(users).some(id => 
            id !== socket.id && users[id].username.toLowerCase() === usernameLower
        );

        if (isDuplicate) {
            const errorMsg = formatMessage('System', `The username '${username}' is already taken. Please choose another.`);
            socket.emit('chat-message', { text: errorMsg, avatar: null });
            return;
        }

        // Store the user data
        users[socket.id] = { 
            username: username, 
            avatar: newAvatar, 
            id: socket.id 
        };

        // If the user is currently in VC, update their VC profile data (e.g., new username/avatar)
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].username = username;
            vcUsers[socket.id].avatar = newAvatar;
            broadcastVCUserList();
        }
        
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
            io.emit('chat-message', { text: joinMsg, avatar: null });
            addToHistory(joinMsg);
        }
        
        broadcastUserList();
    });

    // --- 2. Handle Chat Messages (Includes Command Logic) ---
    socket.on('chat-message', (msg) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;
        const senderAvatar = userData.avatar;
        const senderId = socket.id;

        if (msg.startsWith('/')) {
            const parts = msg.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' '); 
            
            let response = '';

            // --- GENERAL COMMANDS (/msg) ---
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
                        const sentMsg = formatMessage('System', `**[PM to ${targetUsername}]**: **${privateMessage}**`);
                        socket.emit('chat-message', { text: sentMsg, avatar: null });

                        const receivedMsg = formatMessage('System', `**[PM from ${sender}]**: **${privateMessage}**`);
                        io.to(recipientId).emit('chat-message', { text: receivedMsg, avatar: null });
                        
                        return;
                    }
                }
            } 
            
            // --- ADMIN COMMANDS (kl_ only) ---
            else if (sender === ADMIN_USERNAME) {
                switch (command) {
                    case 'server':
                        if (args) {
                            const serverMsg = formatMessage('Announcement', `: **${args}**`);
                            io.emit('chat-message', { text: serverMsg, avatar: null });
                            addToHistory(serverMsg);
                            return; 
                        } else {
                            response = `Usage: /server [message]. Broadcasts a server-wide announcement.`;
                        }
                        break;

                    case 'clear':
                        io.emit('clear-chat'); 
                        messageHistory.length = 0; 
                        const clearConfirmationMsg = formatMessage('System', `Chat history cleared by admin (${sender}).`);
                        io.emit('chat-message', { text: clearConfirmationMsg, avatar: null });
                        addToHistory(clearConfirmationMsg);
                        return; 
                    
                    default:
                        response = `Unknown Admin Command: /${command}. Available: /server, /clear.`;
                }
            } else {
                response = `Unknown command: /${command}. Only the /msg command is generally available.`;
            }

            if (response) {
                const commandResponse = formatMessage('System', response);
                socket.emit('chat-message', { text: commandResponse, avatar: null });
            }

        } else if (msg.trim()) {
            const formattedMsg = formatMessage(sender, msg);
            io.emit('chat-message', {
                text: formattedMsg,
                avatar: senderAvatar,
                sender: sender
            });
            addToHistory(formattedMsg);
        }
    });

    // --- 3. Voice Chat Handlers ---

    // Handler to join or leave the VC
    socket.on('vc-join', (isJoining) => {
        const userData = users[socket.id];

        if (!userData) return;

        if (isJoining) {
            // Add user to VC list
            vcUsers[socket.id] = { 
                username: userData.username, 
                avatar: userData.avatar, 
                isMuted: false, // Start unmuted
                id: socket.id
            };
            const joinMsg = formatMessage('System', `**${userData.username}** joined the Voice Chat.`);
            io.emit('chat-message', { text: joinMsg, avatar: null });
            addToHistory(joinMsg);
            
        } else {
            // Remove user from VC list
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                const leaveMsg = formatMessage('System', `**${userData.username}** left the Voice Chat.`);
                io.emit('chat-message', { text: leaveMsg, avatar: null });
                addToHistory(leaveMsg);
            }
        }
        
        broadcastVCUserList();
    });

    // Handler to toggle mute status
    socket.on('vc-mute-toggle', (isMuted) => {
        if (vcUsers[socket.id]) {
            vcUsers[socket.id].isMuted = isMuted;
            broadcastVCUserList(); // Update all clients with new status
        }
    });

    // --- 4. Handle Disconnect ---
    socket.on('disconnect', () => {
        const userData = users[socket.id];
        
        if (userData) {
            delete users[socket.id];
            
            // Remove from VC list on disconnect
            if (vcUsers[socket.id]) {
                delete vcUsers[socket.id];
                broadcastVCUserList(); 
            }
            
            const leaveMsg = formatMessage('System', `User '${userData.username}' left the chat.`);
            io.emit('chat-message', { text: leaveMsg, avatar: null }); 
            addToHistory(leaveMsg);
            
            broadcastUserList();
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
