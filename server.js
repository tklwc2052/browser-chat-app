const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
// users now stores an object { username: string, avatar: string (Base64 URL), id: string }
const users = {}; 
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

    // CRITICAL FIX: Only add the colon if it's a regular message.
    if (sender === 'System' || sender === 'Announcement') {
        return `**${sender}** ${text} [${time}]`; // NO colon here (Colon added in command handler for specific cases)
    }
    return `**${sender}**: ${text} [${time}]`; // Regular message retains colon
}

/**
 * Sends the current list of online users to all connected clients.
 */
function broadcastUserList() {
    // Send the full user object (including avatar)
    const onlineUsers = Object.values(users);
    io.emit('user-list-update', onlineUsers);
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

    // Send the message history to the newly connected user
    socket.emit('history', messageHistory);
    broadcastUserList(); // Ensure new user gets initial user list

    // --- 1. Set Username & Avatar ---
    // UPDATED: Now receives an object { username, avatar }
    socket.on('set-username', ({ username, avatar }) => {
        const oldUserData = users[socket.id] || {};
        const oldUsername = oldUserData.username;
        // Use a default Base64-friendly image if none provided
        const newAvatar = avatar || 'placeholder-avatar.png'; 

        if (!username) {
            return;
        }

        const usernameLower = username.toLowerCase();
        
        // Check for duplicate username among other users
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
            avatar: newAvatar, // Store the Base64 data URL
            id: socket.id 
        };

        console.log(`User data set for ${socket.id}: ${username}`);
        
        // Only broadcast join/change message if the username actually changed
        if (username !== oldUsername) {
            const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
            io.emit('chat-message', { text: joinMsg, avatar: null });
            addToHistory(joinMsg);
        }
        
        broadcastUserList();
    });

    // --- 2. Handle Chat Messages ---
    // UPDATED: Now includes avatar data in the message object
    socket.on('chat-message', (msg) => {
        const userData = users[socket.id] || { username: 'Anonymous', avatar: 'placeholder-avatar.png' };
        const sender = userData.username;
        const senderAvatar = userData.avatar;
        const senderId = socket.id;

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
                    // Find the recipient's socket ID
                    const recipientId = Object.keys(users).find(id => users[id].username.toLowerCase() === targetUsername.toLowerCase());

                    if (!recipientId) {
                        response = `User '${targetUsername}' not found or not online.`;
                    } else if (recipientId === senderId) {
                        response = `You cannot send a private message to yourself.`;
                    } else {
                        // --- Send PMs ---
                        
                        // 1. Send to Sender (Confirmation, visible to sender only)
                        const sentMsg = formatMessage('System', `**[PM to ${targetUsername}]**: **${privateMessage}**`);
                        socket.emit('chat-message', { text: sentMsg, avatar: null });

                        // 2. Send to Receiver (Actual PM, visible to receiver only)
                        const receivedMsg = formatMessage('System', `**[PM from ${sender}]**: **${privateMessage}**`);
                        io.to(recipientId).emit('chat-message', { text: receivedMsg, avatar: null });
                        
                        return; // PM handled, exit command processing
                    }
                }
            } 
            
            // --- 2. ADMIN COMMANDS (kl_ only) ---
            else if (sender === ADMIN_USERNAME) {
                switch (command) {
                    case 'server':
                        if (args) {
                            // Format: **Announcement**: **[Your message]** [Time]
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
                // Non-admin trying to use any command (or a command other than /msg)
                response = `Unknown command: /${command}. Only the /msg command is generally available.`;
            }

            // If a response was generated (e.g., error, usage message)
            if (response) {
                const commandResponse = formatMessage('System', response);
                socket.emit('chat-message', { text: commandResponse, avatar: null });
            }

        } else if (msg.trim()) {
            // Not a command, broadcast the message
            // Send an object containing the formatted string and the avatar URL
            const formattedMsg = formatMessage(sender, msg);
            io.emit('chat-message', {
                text: formattedMsg,
                avatar: senderAvatar,
                sender: sender // Need sender for client-side grouping
            });
            addToHistory(formattedMsg); // Still logging only the text string to history
        }
    });

    // --- 3. Handle Disconnect ---
    socket.on('disconnect', () => {
        const userData = users[socket.id];
        
        if (userData) {
            delete users[socket.id];
            console.log(`User disconnected: ${userData.username} (${socket.id})`);
            
            const leaveMsg = formatMessage('System', `User '${userData.username}' left the chat.`);
            io.emit('chat-message', { text: leaveMsg, avatar: null }); // System messages don't need avatar
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
