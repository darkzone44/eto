require('dotenv').config();
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const bodyParser = require('body-parser');
const multer = require('multer');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' });
const app = express();
const server = http.createServer(app);
const io = socketio(server);

// Static assets
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
      secure: true,
    };
  }).filter(x => x !== null);
}

async function launchBrowser(socket) {
  socket.emit('log', {type: 'system', msg: '🚦 Starting Chromium browser...'});
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true
  });
}

async function loadCookiesFromString(page, cookieString, socket) {
  if (!cookieString) throw new Error('Cookie string is empty');
  const cookies = parseCookieStringToJSON(cookieString);
  await page.setCookie(...cookies);
  socket.emit('log', {type: 'auth', msg: '🍪 Cookies injected successfully.'});
}

async function sendMessageToThread(threadId, message, cookieString, socket) {
  if (!threadId) throw new Error('Thread ID required');
  const browser = await launchBrowser(socket);
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60000);
    socket.emit('log', {type: 'system', msg: '🔑 Injecting cookies...' });
    await loadCookiesFromString(page, cookieString, socket);

    socket.emit('log', {type: 'status', msg: `🌎 Navigating to thread: ${threadId}`});
    const url = `https://www.facebook.com/messages/t/${threadId}`;
    await page.goto(url, { waitUntil: 'networkidle2' });

    socket.emit('log', {type: 'status', msg: `🕵️ Checking login status...`});
    const pageTitle = await page.title();
    if (pageTitle.toLowerCase().includes('login')) {
      throw new Error('❌ Facebook wants login -- check cookies.');
    }
    socket.emit('log', {type: 'success', msg: `✅ Login success, searching for message composer...`});

    // Find message input
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
      'input[type="text"]'
    ];

    let composer = null;
    for (const s of selectors) {
      socket.emit('log', {type: 'selector', msg: `🔍 Trying selector: ${s}`});
      try {
        await page.waitForSelector(s, { timeout: 2500 });
        composer = s;
        break;
      } catch (e) {}
    }
    if (!composer) {
      throw new Error('❌ Message box not found - DOM changed or E2EE active!');
    }
    socket.emit('log', {type: 'selector', msg: `✏️ Message box found: ${composer}`});

    await page.focus(composer);
    await page.evaluate((sel, msg) => {
      const el = document.querySelector(sel);
      if (!el) return;
      if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
        el.focus();
        el.innerText = msg;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.value = msg;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, composer, message);

    // Send
    const sendSelectors = [
      'a[aria-label="Send"]',
      'button[aria-label="Send"]',
      'button[type="submit"]',
      '._30yy._38lh',
      'div[aria-label="Send"]'
    ];
    let clicked = false;
    for (const sel of sendSelectors) {
      const exists = await page.$(sel);
      if (exists) {
        await exists.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await page.keyboard.press('Enter');
    }

    socket.emit('log', {type: 'success', msg: `🚀 Message sent: "${message}"`});
    await page.waitForTimeout(1500);
    await browser.close();
    return { ok: true };
  } catch (err) {
    socket.emit('log', {type: 'error', msg: `❌ ${err.message}`});
    await browser.close();
    throw err;
  }
}

let sending = false;
let sentCount = 0;
let currentTask = null;

io.on('connection', socket => {
  socket.emit('log', {type: 'system', msg: '🟢 Connected to bot system.'});
  socket.emit('status_box', {active: false, sending: false, count: sentCount});
  socket.on('start', async ({ cookieString, threadId, delaySeconds, messages }) => {
    if (currentTask) {
      socket.emit('log', {type: 'system', msg: '⚠️ Already sending messages, stop to restart.'});
      return;
    }
    sending = true;
    sentCount = 0;
    socket.emit('status_box', {active: true, sending: true, count: sentCount});
    socket.emit('log', {type: 'system', msg: '▶️ Starting message sending...'});
    currentTask = (async () => {
      try {
        for (const message of messages) {
          if (!sending) break;
          await sendMessageToThread(threadId, message, cookieString, socket);
          sentCount++;
          socket.emit('count', sentCount);
          socket.emit('status_box', {active: true, sending: true, count: sentCount});
          await new Promise(r => setTimeout(r, delaySeconds * 1000));
        }
        socket.emit('log', {type: 'system', msg: `✅ All messages sent!`});
        socket.emit('status_box', {active: true, sending: false, count: sentCount});
        sending = false;
        currentTask = null;
      } catch (e) {
        socket.emit('log', {type: 'error', msg: `❌ Sending stopped: ${e.message}`});
        socket.emit('status_box', {active: false, sending: false, count: sentCount});
        sending = false;
        currentTask = null;
      }
    })();
  });

  socket.on('stop', () => {
    sending = false;
    socket.emit('log', {type: 'system', msg: '⏹️ Stopped message sending.'});
    socket.emit('status_box', {active: false, sending: false, count: sentCount});
    currentTask = null;
  });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
