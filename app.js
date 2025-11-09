require('dotenv').config();
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.static('public'));
app.use(bodyParser.json());

function parseCookieStringToJSON(str) {
  return str.split(';').map(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    const value = rest.join('=');
    if (!name) return null;
    return {
      name,
      value: decodeURIComponent(value),
      domain: '.facebook.com',
      path: '/',
      httpOnly: false,
      secure: true
    };
  }).filter(x => x !== null);
}

async function launchBrowser(socket) {
  socket.emit('log', { type: 'system', msg: 'Launching Chromium...' });
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });
}

async function sendMessageToThread(threadId, message, cookieString, socket) {
  if (!threadId) throw new Error('Thread ID required!');
  const browser = await launchBrowser(socket);
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60000);
    await page.setCookie(...parseCookieStringToJSON(cookieString));
    await page.goto(`https://www.facebook.com/messages/t/${threadId}`, { waitUntil: 'networkidle2' });
    // (REST message typing/send logic here - same as before)
    socket.emit('log', { type: 'success', msg: `Message sent: "${message}"` });
    await browser.close();
  } catch (err) {
    socket.emit('log', { type: 'error', msg: 'Error: '+err.message });
    await browser.close();
  }
}

let sending = false, sentCount = 0, currentTask = null;

io.on('connection', socket => {
  console.log('socket connected!');
  socket.emit('log', { type: 'system', msg: '🟢 Connected!' });
  socket.on('start', async ({ cookieString, threadId, delaySeconds, messages }) => {
    console.log('Start event arrived!', { threadId, count: messages.length });
    sending = true;
    sentCount = 0;
    currentTask = (async () => {
      for (const message of messages) {
        if (!sending) break;
        await sendMessageToThread(threadId, message, cookieString, socket);
        sentCount++;
        socket.emit('count', sentCount);
        await new Promise(r => setTimeout(r, delaySeconds * 1000));
      }
      sending = false;
      currentTask = null;
    })();
  });
  socket.on('stop', () => {
    sending = false;
    socket.emit('log', { type: 'system', msg: 'Stopped.' });
    currentTask = null;
  });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
