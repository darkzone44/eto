
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

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Global
let sending = false;
let sentCount = 0;

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

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true
  });
}

async function loadCookiesFromString(page, cookieString) {
  if (!cookieString) throw new Error('Cookie string is empty');
  const cookies = parseCookieStringToJSON(cookieString);
  await page.setCookie(...cookies);
}

async function sendMessageToThread(threadId, message, cookieString, socket) {
  if (!threadId) throw new Error('Thread ID required');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60000);
    await loadCookiesFromString(page, cookieString);

    socket.emit('log', `Navigating to thread ${threadId}...`);
    const url = `https://www.facebook.com/messages/t/${threadId}`;
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Find message composer
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea'
    ];

    let composer = null;
    for (const s of selectors) {
      try {
        await page.waitForSelector(s, { timeout: 5000 });
        composer = s;
        break;
      } catch (e) {}
    }
    if (!composer) {
      socket.emit('log', 'Message composer not found, DOM may have changed.');
      throw new Error('Message composer not found on page');
    }

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

    // Click send
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

    await page.waitForTimeout(2000);
    socket.emit('log', `Message sent to thread ${threadId}: "${message}"`);

    await browser.close();
    return true;
  } catch (err) {
    await browser.close();
    socket.emit('log', `Error: ${err.message}`);
    throw err;
  }
}

let currentTask = null;

io.on('connection', socket => {
  socket.emit('log', 'Connected to server');

  socket.on('start', async ({ cookieString, threadId, delaySeconds, messages }) => {
    if (currentTask) {
      socket.emit('log', 'Already sending messages, please stop current task first.');
      return;
    }
    sending = true;
    sentCount = 0;
    socket.emit('log', 'Starting message sending...');
    currentTask = (async () => {
      try {
        for (const message of messages) {
          if (!sending) break;
          await sendMessageToThread(threadId, message, cookieString, socket);
          sentCount++;
          socket.emit('count', sentCount);
          await new Promise(r => setTimeout(r, delaySeconds * 1000));
        }
        socket.emit('log', 'Finished sending messages.');
        sending = false;
        currentTask = null;
      } catch (e) {
        socket.emit('log', `Error in sending task: ${e.message}`);
        sending = false;
        currentTask = null;
      }
    })();
  });

  socket.on('stop', () => {
    sending = false;
    socket.emit('log', 'Stopped message sending.');
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
