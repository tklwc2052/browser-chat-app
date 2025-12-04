const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
// NOTE: Removed 'fs' as Nhost handles persistence

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (Assuming client files are in the same directory)
app.use(express.static(__dirname));

// --- SERVER-SIDE STATE ---
let history = []; 
const MESSAGE_HISTORY_LIMIT = 50;

// Use a Map to track connected sessions (sockets)
const userSessions = new Map();

// Removed USER_PASSWORDS object and loadUsers/saveUsers functions

function getFormattedTime() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

io.on('connection', (socket) => {
    console.log(`a user connected: ${socket.id}`);

    // --- NEW: Handle Login Success SIGNAL from Client (Nhost already verified user) ---
    // This event signals that the user has been successfully logged in/registered via Nhost.
    socket.on('nhost-login-success', (displayName) => {
        const safeUsername = displayName; 
        
        // 1. Register the connection on the Socket.IO server.
        
        if (!userSessions.has(safeUsername)) {
            // New user session
            userSessions.set(safeUsername, {
                username: safeUsername,
                socketIds: new Set([socket.id])
            });
            console.log(`New session created for ${safeUsername}.`);
            socket.username = safeUsername;
            // We only broadcast a join message if it's the first connection for this user
            io.emit('system-message', `**${safeUsername}** joined the chat.`);
            
        } else {
            // Existing user session: add the new socket ID (for a new tab)
            const session = userSessions.get(safeUsername);
            session.socketIds.add(socket.id);
            console.log(`Socket ${socket.id} joined existing session for ${safeUsername}.`);
            socket.username = safeUsername;
            socket.emit('system-message', `Reconnected as **${safeUsername}**.`); 
        }
        
        // Send history and updated list after socket registration
        socket.emit('history', history);
        broadcastUserList();
    });

    // --- Message Handling ---
    socket.on('chat-message', (msg) => {
        const username = socket.username;
        if (!username) return; 

        const time = getFormattedTime();
        const formattedMessage = `**${username}**: ${msg} [${time}]`;

        io.emit('chat-message', formattedMessage);

        history.push(formattedMessage);
        if (history.length > MESSAGE_HISTORY_LIMIT) {
            history.shift(); 
        }
    });

    // --- Disconnect Handling ---
    socket.on('disconnect', () => {
        console.log(`user disconnected: ${socket.id}`);
        const username = socket.username;
        
        if (username && userSessions.has(username)) {
            const session = userSessions.get(username);
            session.socketIds.delete(socket.id); 
            
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
        const activeUsers = Array.from(userSessions.keys());
        io.emit('user-list-update', activeUsers);
    }
    
    // Clear Chat Logic 
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
