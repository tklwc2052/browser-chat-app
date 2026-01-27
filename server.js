const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- JUKEBOX STATE ---
let musicQueue = [];       // List of songs waiting to play
let currentSong = null;    // Current song object { videoId, title, etc }
let songStartTime = 0;     // Timestamp when current song started (for syncing)

// Helper: Play the next song in the queue
function playNextSong() {
    if (musicQueue.length > 0) {
        currentSong = musicQueue.shift(); // Remove first song from queue
        songStartTime = Date.now();       // Record start time
        
        console.log(`🎵 Now Playing: ${currentSong.title}`);

        // Tell everyone to play this video ID starting at 0 seconds
        io.emit('jukebox-play', {
            videoId: currentSong.videoId,
            title: currentSong.title,
            startAt: 0
        });
        
        // Update everyone's queue count
        io.emit('jukebox-update-queue', musicQueue);
    } else {
        // No more songs
        currentSong = null;
        io.emit('jukebox-stop');
    }
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    console.log('A user connected');

    // --- CHAT LOGIC (Existing) ---
    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });

    socket.on('typing', (username) => {
        socket.broadcast.emit('typing', username);
    });

    socket.on('stop typing', () => {
        socket.broadcast.emit('stop typing');
    });

    // --- JUKEBOX LOGIC (New) ---

    // 1. User Joins: Sync them to the current song
    socket.on('jukebox-join', () => {
        // Send them the current queue size immediately
        socket.emit('jukebox-update-queue', musicQueue);

        if (currentSong) {
            // Calculate how many seconds into the song we are
            const secondsElapsed = (Date.now() - songStartTime) / 1000;
            
            socket.emit('jukebox-play', {
                videoId: currentSong.videoId,
                title: currentSong.title,
                startAt: secondsElapsed // Tell client to jump to this timestamp
            });
        }
    });

    // 2. User Adds Song
    socket.on('jukebox-add', (songData) => {
        // Add to queue
        musicQueue.push(songData);
        io.emit('jukebox-update-queue', musicQueue);

        // If nothing is playing, start this song immediately
        if (!currentSong) {
            playNextSong();
        }
    });

    // 3. Song Ended (Client reports it finished)
    socket.on('jukebox-song-ended', () => {
        // We only want to skip if we are actually playing something
        // (Prevents double-skipping if multiple users report end at same time)
        if (currentSong) {
            playNextSong();
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
