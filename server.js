const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- State Management ---
const users = {}; // Stores socket.id -> username mapping
const messageHistory = []; // Stores formatted message strings

// Maximum number of messages to keep in history
const MAX_HISTORY = 50; 

// --- Utility Functions ---

/**
 * Formats a message string with username and timestamp.
 * Example: **[System]**: User 'NewUser' joined. [04:30 PM]
 * @param {string} sender - The sender's name (or System/Announcement).
 * @param {string} text - The raw message content.
 * @returns {string} The formatted message string.
 */
function formatMessage(sender, text) {
    const now = new Date();
    // Use US time format (e.g., 04:30 PM)
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `**${sender}**: ${text} [${time}]`;
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
        messageHistory.shift(); // Remove the oldest message
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

        // Ensure username is not empty and hasn't been set yet (or is being changed)
        if (!username || username === oldUsername) {
            return;
        }

        // Check for duplicate names (case-insensitive)
        const usernameLower = username.toLowerCase();
        const isDuplicate = Object.values(users).some(name => name.toLowerCase() === usernameLower);

        if (isDuplicate) {
            // Send an error back to the client
            const errorMsg = formatMessage('System', `The username '${username}' is already taken. Please choose another.`);
            socket.emit('chat-message', errorMsg);
            return;
        }

        // Store and announce the new username
        users[socket.id] = username;
        console.log(`Username set for ${socket.id}: ${username}`);
        
        const joinMsg = formatMessage('System', `User '${username}' joined the chat.`);
        io.emit('chat-message', joinMsg);
        addToHistory(joinMsg);
        
        broadcastUserList();
    });

    // --- 2. Handle Chat Messages ---
    socket.on('chat-message', (msg) => {
        const sender = users[socket.id] || 'Anonymous';

        // Check if the message is a command
        if (msg.startsWith('/')) {
            const parts = msg.trim().slice(1).split(/\s+/); // Remove '/' and split by space
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);
            
            let response = '';

            switch (command) {
                case 'help':
                    response = "Available commands: /help, /users, /clear, /time";
                    break;
                case 'users':
                    const userList = Object.values(users).join(', ') || 'No users online.';
                    response = `Online users: ${userList}`;
                    break;
                case 'clear':
                    if (sender === 'Admin' || sender === 'System') { // Basic check for privileged command
                        io.emit('clear-chat'); // Tell clients to clear their screens
                        messageHistory.length = 0; // Clear server history
                        response = "Chat history cleared by the system.";
                    } else {
                        response = "You do not have permission to use /clear.";
                    }
                    break;
                case 'time':
                    const now = new Date();
                    response = `Server time is ${now.toLocaleTimeString('en-US')}.`;
                    break;
                default:
                    response = `Unknown command: /${command}. Type /help for a list of commands.`;
            }

            const commandResponse = formatMessage('Announcement', response);
            socket.emit('chat-message', commandResponse);

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
