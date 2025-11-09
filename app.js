require('dotenv').config();
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const puppeteer = require('puppeteer-core');
const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.static('public'));

io.on('connection', socket => {
  console.log('✅ socket connected');
  socket.emit('log', { type: 'system', msg: 'Socket connected.' });
  socket.on('start', async ({ cookieString, threadId, delaySeconds, messages }) => {
    console.log('Received start event:', threadId, messages.length);
    socket.emit('log', { type: 'system', msg: 'START received: ' + threadId });
    // FAKE TEST: To see if logs arrive
    messages.forEach((msg, idx) => socket.emit('log', {type:"system", msg:"Fake sending → " + msg}));

    // ---- Uncomment below to enable puppeteer real sending ----
    /*
    for (const message of messages) {
      try {
        await sendMessageToThread(threadId, message, cookieString, socket);
        socket.emit('log', { type: 'success', msg: 'Sent: ' + message });
      } catch (e) {
        socket.emit('log', {type:'error', msg: e.message});
      }
      await new Promise(r => setTimeout(r, delaySeconds*1000));
    }
    */
  });
});
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server on ' + PORT));
