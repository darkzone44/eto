const express = require('express');
const http = require('http');
const socketio = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.static('public'));

io.on('connection', socket => {
  console.log('🟢 socket connected!');
  socket.emit('log', { type: 'system', msg: '🟢 socket connected!' });
  socket.on('start', data => {
    console.log('🔥 start event:', data);
    socket.emit('log', { type: 'system', msg: '🔥 start event received.' });
    if(Array.isArray(data.messages)){
      data.messages.forEach((msg, idx) => {
        socket.emit('log', { type: 'system', msg: `[${idx+1}] Msg: ${msg}` });
      });
    } else {
      socket.emit('log', { type: 'error', msg: 'No messages loaded!' });
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server on ' + PORT));
