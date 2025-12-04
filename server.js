const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
const users = {}; 
const messageHistory = []; 
const MAX_HISTORY = 50; 

// --- Configuration ---
const ADMIN_USERNAME = 'kl_'; // <<< Designated Admin User

// --- Utility Functions ---

/**
 * Formats a message string with username and timestamp.
 * Example: **[User]**: Raw message content [04:30 PM]
 * @param {string} sender - The sender's name (or System/Announcement).
 * @param {string} text - The raw message content.
 * @returns {string} The formatted message string.
 */
function formatMessage(sender, text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // CRITICAL FIX: Only add the colon if it's a regular message.
    if (sender === 'System' || sender === 'Announcement') {
        return `**${sender}** ${text} [${time}]`; // NO colon here
    }
    return `**${sender}**: ${text} [${time}]`; // Regular message retains colon
}

/**
 * Sends the current list of online users to all connected clients.
 */
function broadcastUserList() {
    const onlineUsernames = Object.values(users);
    io.emit('user-list-update', onlineUsernames);
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

    // --- 1. Set Username ---
    socket.on('set-username', (username) => {
        const oldUsername = users[socket.id];

        if (!username || username === oldUsername) {
            return;
        }

        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.values(users).some(name => name.toLowerCase() === usernameLower);

        if (isDuplicate) {
            const errorMsg = formatMessage('System', `The username '${username}' is already taken. Please choose another.`);
            socket.emit('chat-message', errorMsg);
            return;
        }

        users[socket.id] = username;
        console.log(`Username set for ${socket.id}: ${username}`);
        
        const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
        io.emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        
        broadcastUserList();
    });

    // --- 2. Handle Chat Messages (Implementing Admin Commands) ---
    socket.on('chat-message', (msg) => {
        const sender = users[socket.id] || 'Anonymous';

        // Check if the message is a command
        if (msg.startsWith('/')) {
            const parts = msg.trim().slice(1).split(/\s+/); 
            const command = parts[0].toLowerCase();
            // Get the rest of the message for command arguments
            const args = parts.slice(1).join(' '); 
            
            let response = '';
            
            // Check for admin privileges
            if (sender === ADMIN_USERNAME) {
                switch (command) {
                    case 'server':
                        if (args) {
                            // Send a global bold announcement to all users
                            const serverMsg = formatMessage('Announcement', `**SERVER MESSAGE**: **${args}**`);
                            io.emit('chat-message', serverMsg);
                            addToHistory(serverMsg);
                            return; // Stop processing after execution
                        } else {
                            response = `Usage: /server [message]. The message will be broadcast server-wide in bold.`;
                        }
                        break;

                    case 'clear':
                        // 1. Tell all clients to clear their chat history
                        io.emit('clear-chat'); 
                        // 2. Clear server-side history
                        messageHistory.length = 0; 
                        // 3. Send confirmation message to all clients
                        const clearConfirmationMsg = formatMessage('System', `Chat history cleared by admin (${sender}).`);
                        io.emit('chat-message', clearConfirmationMsg);
                        addToHistory(clearConfirmationMsg);
                        return; // Stop processing after execution
                    
                    default:
                        response = `Unknown Admin Command: /${command}. Available: /server, /clear.`;
                }
            } else {
                // Not an admin, check for non-admin commands (currently none)
                response = `You do not have permission to use commands. Only '${ADMIN_USERNAME}' can use privileged commands.`;
            }

            // If a response was generated (i.e., a command was attempted)
            if (response) {
                const commandResponse = formatMessage('System', response);
                socket.emit('chat-message', commandResponse);
            }

        } else if (msg.trim()) {
            // Not a command, broadcast the message
            const formattedMsg = formatMessage(sender, msg);
            io.emit('chat-message', formattedMsg);
            addToHistory(formattedMsg);
        }
    });

    // --- 3. Handle Disconnect ---
    socket.on('disconnect', () => {
        const username = users[socket.id];
        
        if (username) {
            delete users[socket.id];
            console.log(`User disconnected: ${username} (${socket.id})`);
            
            const leaveMsg = formatMessage('System', `User '${username}' left the chat.`);
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
