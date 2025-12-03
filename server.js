// Load the necessary modules
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Use the environment variable for the allowed origin (CORS)
// This is critical for Render deployment stability and security.
const allowedOrigin = process.env.RENDER_EXTERNAL_URL || "*";

// Initialize Socket.IO and attach it to the server
const io = new Server(server, {
  cors: {
    origin: allowedOrigin, // Now uses the environment variable or defaults to all
    methods: ["GET", "POST"]
  }
});

// --- Server Configuration ---

// Serve static files (index.html, styles.css) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Define the port. We use the environment variable PORT provided by Render
const PORT = process.env.PORT || 3000;

// --- Real-Time (Socket.IO) Logic ---

// A simple object to track all online users: { socketId: username }
let onlineUsers = {};

// Listen for new client connections
io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}`);

  // 1. Listen for 'set-username' event
  socket.on('set-username', (username) => {
    onlineUsers[socket.id] = username;
    
    // Announce the new user to everyone
    socket.broadcast.emit('chat-message', formatMessage('System', `${username} has joined the chat.`));
    
    // Update the online list for ALL connected clients
    io.emit('user-list-update', Object.values(onlineUsers)); 
  });

  // 2. Listen for 'chat-message' event
  socket.on('chat-message', (msg) => {
    const user = onlineUsers[socket.id] || 'Guest';
    
    // Send the formatted message (user + time stamp) to ALL connected clients
    io.emit('chat-message', formatMessage(user, msg));
  });

  // 3. Listen for 'disconnect' event
  socket.on('disconnect', () => {
    const disconnectedUser = onlineUsers[socket.id];
    
    if (disconnectedUser) {
      console.log(`User disconnected: ${disconnectedUser}`);
      delete onlineUsers[socket.id];
      
      // Announce the user left
      socket.broadcast.emit('chat-message', formatMessage('System', `${disconnectedUser} has left the chat.`));
      
      // Update the online list for ALL connected clients
      io.emit('user-list-update', Object.values(onlineUsers));
    }
  });
});

// --- Helper Function ---
function formatMessage(user, text) {
  // Get time in 12hr format: HH:MM AM/PM
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  
  // Return the full message string: [user]:[message] [time]
  return `**${user}**: ${text} [${time}]`;
}

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
