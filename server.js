// Load the necessary modules
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Use the environment variable for the allowed origin (CORS) for Render stability
const allowedOrigin = process.env.RENDER_EXTERNAL_URL || "*";

// Initialize Socket.IO and attach it to the server
const io = new Server(server, {
  cors: {
    origin: allowedOrigin, 
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
// Array to store the message history (in-memory, limited to 100)
const messageHistory = []; 

// Listen for new client connections
io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}`);

  // Send the entire message history to the newly connected client only
  socket.emit('history', messageHistory); 

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
    let user = onlineUsers[socket.id] || 'Guest';
    let messageText = msg;
    
    // Check for moderator user
    const isModerator = (user === 'kl_');

    // --- Command Detection and Private Feedback ---
    
    // Identify if the message is any command we care about
    const isServerCommand = messageText.toLowerCase().startsWith('/server ');
    const isClearCommand = messageText.toLowerCase() === '/clear';
    const isCommand = isServerCommand || isClearCommand;

    // If it is a command, but the user is NOT a moderator, send private feedback and exit.
    if (isCommand && !isModerator) {
        const commandName = messageText.split(' ')[0];
        const feedbackMessage = formatMessage('System', `You do not have permission to execute the "${commandName}" command.`);
        
        // Use socket.emit() to send the message ONLY to the sender's socket
        socket.emit('chat-message', feedbackMessage); 
        
        // Exit the function to prevent the command from being processed/broadcast.
        return;
    }
    // --- END Command Detection ---

    // --- Handle /server announcement command (ONLY if isModerator is true) ---
    if (isServerCommand && isModerator) {
      messageText = messageText.substring(8).trim(); 
      
      if (messageText) {
          // Format as BOLD and UNDERLINE
          messageText = `__**${messageText}**__`; 
          user = 'Announcement'; // Change the displayed sender name
      } else {
          user = 'kl_';
      }
    }
    
    // --- Handle /clear command (ONLY if isModerator is true) ---
    if (isClearCommand && isModerator) {
      
      messageHistory.length = 0; // 1. Clear history on the server immediately
      
      // 2. Send the signal to all clients to clear their screens first.
      io.emit('clear-chat'); 

      // 3. Create the announcement message.
      const clearAnnouncement = formatMessage('System', 'Chat history has been cleared by the moderator.');
      
      // 4. Use a short delay before sending the confirmation message.
      // This ensures the client finishes clearing the screen before receiving the next message.
      setTimeout(() => {
        io.emit('chat-message', clearAnnouncement); 
      }, 50);
      
      return; // Stop processing/storing/broadcasting the literal "/clear" message
    }
    // --- END command handling ---

    // If not a command or if the command was executed by a moderator, continue standard message handling
    const fullMessage = formatMessage(user, messageText);
    
    // Store history and broadcast as usual
    messageHistory.push(fullMessage);
    if (messageHistory.length > 100) { 
      messageHistory.shift(); 
    }
    io.emit('chat-message', fullMessage);
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
  const now = new Date();
  
  // Explicitly set the time zone to Eastern Time (EST/EDT)
  const options = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York'
  };

  const time = now.toLocaleTimeString('en-US', options);
  
  // Return the full message string: **[user]**: [message] [time]
  return `**${user}**: ${text} [${time}]`;
}

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
