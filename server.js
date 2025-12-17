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
const vcParticipants = {}; // NEW: Tracks users currently in voice chat (socket.id: username)

// --- Configuration ---
const ADMIN_USERNAME = 'kl_'; // Designated Admin User (You!)

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
        return `**${sender}** ${text} [${time}]`; // NO colon here (Colon added in command handler for specific cases)
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
 * Sends the current list of voice chat participants to all connected clients.
 */
function broadcastVcUserList() {
    // Only send the usernames
    io.emit('vc-user-list-update', Object.values(vcParticipants));
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

    // Send the message history and current VC list to the newly connected user
    socket.emit('history', messageHistory);
    broadcastVcUserList(); // Ensure new users see who is in VC immediately

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

    // --- 2. Handle Chat Messages (Implementing Admin and Private Message Commands) ---
    socket.on('chat-message', (msg) => {
        const sender = users[socket.id] || 'Anonymous';
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
                    const recipientId = Object.keys(users).find(id => users[id].toLowerCase() === targetUsername.toLowerCase());

                    if (!recipientId) {
                        response = `User '${targetUsername}' not found or not online.`;
                    } else if (recipientId === senderId) {
                        response = `You cannot send a private message to yourself.`;
                    } else {
                        // --- Send PMs ---
                        
                        // 1. Send to Sender (Confirmation, visible to sender only)
                        const sentMsg = formatMessage('System', `**[PM to ${targetUsername}]**: **${privateMessage}**`);
                        socket.emit('chat-message', sentMsg);

                        // 2. Send to Receiver (Actual PM, visible to receiver only)
                        const receivedMsg = formatMessage('System', `**[PM from ${sender}]**: **${privateMessage}**`);
                        io.to(recipientId).emit('chat-message', receivedMsg);
                        
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
                            const serverMsg = formatMessage('Announcement', `: **${args
