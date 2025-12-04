const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
// Attach Socket.IO to the HTTP server
const io = socketIo(server);

// CRITICAL FIX: Serve static files (index.html, styles.css, etc.) from the root directory
app.use(express.static(__dirname));

// --- SERVER-SIDE STATE ---
let history = []; // Stores the last N messages
const MESSAGE_HISTORY_LIMIT = 50;

// Use a Map to track connected users by username. The value is an object
// containing the user's password and a Set of their active socket IDs.
const userSessions = new Map();

// Hardcoded Password/Session Key for this example:
// To log in as 'kl', the user must send '1234'. To log in as 'guest', they must send '0000'.
const USER_PASSWORDS = {
    'kl': '1234',
    'guest': '0000' 
    // Add more accounts here as needed
};
// -------------------------

// Helper function to get the current time in a readable format
function getFormattedTime() {
    const now = new Date();
    // Use toLocaleTimeString for simple HH:MM AM/PM format
    return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

io.on('connection', (socket) => {
    console.log(`a user connected: ${socket.id}`);

    // --- Handle username and password setting ---
    socket.on('set-username', (username, password) => {
        const safeUsername = username.trim();

        // 1. Check if the username is defined in our password list
        if (!USER_PASSWORDS[safeUsername]) {
            socket.emit('system-message', `Error: Username "${safeUsername}" is not registered.`);
            return;
        }
        
        // 2. Verify the password
        if (USER_PASSWORDS[safeUsername] !== password) {
            socket.emit('system-message', `Error: Incorrect password for "${safeUsername}".`);
            return;
        }

        // 3. User authenticated: Check/create session
        if (!userSessions.has(safeUsername)) {
            // New user session: initialize with the current socket ID
            userSessions.set(safeUsername, {
                username: safeUsername,
                password: password,
                socketIds: new Set([socket.id])
            });
            console.log(`New session created for ${safeUsername}.`);
            socket.username = safeUsername;
            socket.emit('system-message', `**${safeUsername}** joined the chat.`);
            
        } else {
            // Existing user session: add the new socket ID
            const session = userSessions.get(safeUsername);
            session.socketIds.add(socket.id);
            console.log(`Socket ${socket.id} joined existing session for ${safeUsername}.`);
            socket.username = safeUsername;
            // Don't send a join message to everyone, just a re-connection message to the user
            socket.emit('system-message', `Reconnected as **${safeUsername}**.`); 
        }
        
        // Send history and updated list after successful login
        socket.emit('history', history);
        broadcastUserList();
    });

    // --- Message Handling ---
    socket.on('chat-message', (msg) => {
        const username = socket.username;
        if (!username) return; 

        // Format message with time and username
        const time = getFormattedTime();
        const formattedMessage = `**${username}**: ${msg} [${time}]`;

        // Send to everyone including sender
        io.emit('chat-message', formattedMessage);

        // Update history
        history.push(formattedMessage);
        if (history.length > MESSAGE_HISTORY_LIMIT) {
            history.shift(); // Remove the oldest message
        }
    });

    // --- Disconnect Handling (CRITICAL UPDATE) ---
    socket.on('disconnect', () => {
        console.log(`user disconnected: ${socket.id}`);
        const username = socket.username;
        
        if (username && userSessions.has(username)) {
            const session = userSessions.get(username);
            session.socketIds.delete(socket.id); // Remove this specific socket ID
            
            if (session.socketIds.size === 0) {
                // Last connection for this user closed
                userSessions.delete(username);
                console.log(`Session for ${username} closed.`);
                io.emit('system-message', `**${username}** left the chat.`);
            } else {
                console.log(`${username} still has ${session.socketIds.size} active connections.`);
            }
        }
        broadcastUserList();
    });

    // --- Broadcasts unique usernames based on active sessions ---
    function broadcastUserList() {
        // Get unique usernames from the active sessions
        const activeUsers = Array.from(userSessions.keys());
        io.emit('user-list-update', activeUsers);
    }
    
    // Clear Chat Logic (triggered by an admin button, or manually)
    socket.on('admin-clear-chat', () => {
        history = [];
        io.emit('clear-chat');
        io.emit('system-message', `**[ADMIN]** The chat history has been cleared.`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
