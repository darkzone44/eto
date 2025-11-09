// server.js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let currentTask = null; // holds controller for running task

function parseCookieString(cookieStr) {
  return cookieStr.split(';').map(pair => {
    const p = pair.trim();
    if (!p) return null;
    const eq = p.indexOf('=');
    if (eq === -1) return null;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!name) return null;
    return { name, value, domain: '.facebook.com', path: '/', httpOnly: false, secure: true };
  }).filter(Boolean);
}

async function waitForInputSelector(page) {
  const selectors = [
    'div[contenteditable="true"][role="combobox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  for (const s of selectors) {
    try { await page.waitForSelector(s, { timeout: 3000 }); return s; } catch(e) {}
  }
  return null;
}

async function lastMessageTextInThread(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('div[dir="auto"], div[role="row"] span')).slice(-10);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const t = candidates[i].innerText;
      if (t && t.trim()) return t.trim();
    }
    return null;
  }).catch(() => null);
}

async function sendOneMessage(page, selector, text) {
  try {
    const isCE = await page.evaluate((sel) => { const e = document.querySelector(sel); return !!(e && e.isContentEditable); }, selector);
    if (isCE) {
      await page.evaluate((sel, msg) => {
        const e = document.querySelector(sel);
        e.focus(); e.innerHTML = '';
        e.appendChild(document.createTextNode(msg));
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, selector, text);
      await page.keyboard.press('Enter');
    } else {
      await page.evaluate((sel, msg) => { const e = document.querySelector(sel); if(e) { e.value = msg; e.dispatchEvent(new Event('input', { bubbles: true })); } }, selector, text);
      await page.keyboard.press('Enter');
    }

    // confirm
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const last = await lastMessageTextInThread(page);
      if (last && last.includes(text.substring(0, Math.min(40, text.length)))) return true;
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function runSendingTask(params, progress) {
  // params: { cookie, thread, messages[], delay, headless, mode, maxsend }
  const cookies = parseCookieString(params.cookie || '');
  const browser = await puppeteer.launch({ headless: !!params.headless, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    await page.setCookie(...cookies);
    const url = `https://www.messenger.com/t/${params.thread}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const selector = await waitForInputSelector(page);
    if (!selector) throw new Error('Message input not found');

    let sent = 0;
    let idx = 0;
    const messages = params.messages || [];
    const delay = Math.max(300, parseInt(params.delay || 3000, 10));
    const maxsend = parseInt(params.maxsend || 0, 10);

    while (!progress.stopped) {
      if (maxsend > 0 && sent >= maxsend) break;
      if (messages.length === 0) break;

      const text = messages[idx % messages.length];
      progress.log(`Sending: ${text.substring(0,60)}...`);
      const ok = await sendOneMessage(page, selector, text);
      progress.lastResult = ok ? 'sent' : 'failed';
      progress.sentCount = ++sent;

      // wait with stop checks
      const step = 500; let waited = 0;
      while (!progress.stopped && waited < delay) { await new Promise(r=>setTimeout(r, step)); waited += step; }

      idx++;
      if (params.mode !== 'loop' && idx >= messages.length) break;
    }
    await browser.close();
    progress.done = true;
    return progress;
  } catch (e) {
    try { await browser.close(); } catch(_) {}
    progress.error = String(e);
    progress.done = true;
    return progress;
  }
}

app.post('/start', async (req, res) => {
  if (currentTask && !currentTask.progress.done) {
    return res.status(409).json({ error: 'A task is already running' });
  }
  const { cookie, thread, delay, headless, mode, messages, maxsend } = req.body;
  if (!cookie || !thread || !messages) return res.status(400).json({ error: 'Missing cookie/thread/messages' });

  const progress = { stopped: false, sentCount: 0, lastResult: null, logLines: [], done: false };
  progress.log = (txt) => { progress.logLines.push(`[${new Date().toISOString()}] ${txt}`); console.log(txt); };

  currentTask = { params: { cookie, thread, delay, headless, mode, messages, maxsend }, progress };
  // run async
  runSendingTask(currentTask.params, currentTask.progress).catch(e => { currentTask.progress.error = String(e); currentTask.progress.done = true; });

  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  if (!currentTask) return res.json({ ok: false, msg: 'No task' });
  currentTask.progress.stopped = true;
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  if (!currentTask) return res.json({ running: false });
  res.json({ running: !currentTask.progress.done && !currentTask.progress.stopped, progress: currentTask.progress });
});

app.listen(PORT, () => console.log('Server listening on', PORT));
                               
