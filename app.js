// server.js — Robust Express + Puppeteer sender with Single/Loop/Bulk modes
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));
app.get('/', (r, s) => s.sendFile(path.join(PUBLIC, 'index.html')));

// Simple in-memory log buffer + helpers
const LOG_MAX = 300;
let LOGS = [];
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  LOGS.push(line);
  if (LOGS.length > LOG_MAX) LOGS.shift();
}

// Task state
let TASK = {
  running: false,
  progress: { sentCount: 0, lastResult: null, stopped: false, logLines: LOGS, error: null, done: false }
};

// Util: parse cookie string into puppeteer cookies
function parseCookieString(cs) {
  if (!cs || !cs.trim()) return [];
  return cs.split(';').map(p => {
    const i = p.indexOf('=');
    if (i === -1) return null;
    const name = p.slice(0, i).trim();
    const value = p.slice(i+1).trim();
    return { name, value, domain: '.facebook.com', path: '/', httpOnly: false, secure: true };
  }).filter(Boolean);
}

// Wait for likely input selector
async function waitForInputSelector(page, timeout = 5000) {
  const candidates = [
    'div[contenteditable="true"][role="combobox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of candidates) {
      try {
        const el = await page.$(sel);
        if (el) return sel;
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function lastMessageTextInThread(page) {
  try {
    return await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('div[dir="auto"], span, div')).slice(-30);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const t = nodes[i].innerText;
        if (t && t.trim()) return t.trim();
      }
      return null;
    });
  } catch (e) { return null; }
}

async function sendOneMessage(page, selector, text) {
  try {
    const isCE = await page.evaluate(sel => {
      const e = document.querySelector(sel); return !!(e && e.isContentEditable);
    }, selector).catch(()=>false);

    if (isCE) {
      await page.evaluate((sel, msg) => {
        const e = document.querySelector(sel);
        if (!e) return;
        e.focus();
        e.innerHTML = '';
        e.appendChild(document.createTextNode(msg));
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, selector, text);
      await page.keyboard.press('Enter');
    } else {
      await page.evaluate((sel, msg) => {
        const e = document.querySelector(sel);
        if (!e) return;
        e.value = msg;
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, selector, text);
      await page.keyboard.press('Enter');
    }

    // confirm by checking last visible message for a short time
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const last = await lastMessageTextInThread(page);
      if (last && last.includes(text.substring(0, Math.min(40, text.length)))) return true;
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  } catch (err) {
    log('sendOneMessage error', err && err.message ? err.message : err);
    return false;
  }
}

// Main runner: supports modes: single, loop, bulk
async function runSendingTask(params) {
  TASK.running = true;
  TASK.progress = { sentCount: 0, lastResult: null, stopped: false, logLines: LOGS, error: null, done: false };

  const cookies = parseCookieString(params.cookie || '');
  const messages = Array.isArray(params.messages) ? params.messages : (typeof params.messages === 'string' ? params.messages.split(/\r?\n/).map(s=>s.trim()).filter(Boolean) : []);
  const delay = Math.max(300, parseInt(params.delay || '3000', 10));
  const mode = params.mode || 'single'; // 'single' | 'loop' | 'bulk'
  const targetList = Array.isArray(params.targets) ? params.targets : (params.target ? [params.target] : []);

  log('Starting task', { mode, targets: targetList.length, messages: messages.length, delay });

  // Launch Puppeteer — try to use installed Chrome if available in CHROME_PATH env; otherwise use puppeteer's bundled Chromium (installed via postinstall)
  const chromePathEnv = process.env.CHROME_PATH;
  const launchOpts = { headless: params.headless === true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] };
  if (chromePathEnv) {
    log('Using CHROME_PATH from env:', chromePathEnv);
    launchOpts.executablePath = chromePathEnv;
  } else {
    log('No CHROME_PATH set — using Puppeteer default (bundled) if available.');
  }

  let browser = null;
  let page = null;
  try {
    browser = await puppeteer.launch(launchOpts);
    page = await browser.newPage();
  } catch (err) {
    log('Puppeteer launch failed:', err && err.message ? err.message : err);
    TASK.progress.error = String(err);
    TASK.progress.done = true;
    TASK.running = false;
    return;
  }

  try {
    // set cookies if provided
    try { await page.goto('https://www.facebook.com', {waitUntil:'domcontentloaded', timeout:30000}); } catch(e){}
    if (cookies.length) {
      try { await page.setCookie(...cookies); log('Cookies set:', cookies.map(c=>c.name).join(',')); } catch(e){ log('Cookie set error', e.message || e); }
    }

    // for each target (in bulk) or single target, open messenger thread and send messages
    const targets = (mode === 'bulk' && targetList.length) ? targetList : (targetList.length ? targetList : [params.thread || params.target]);
    for (const t of targets) {
      if (!t) continue;
      const messengerUrl = `https://www.messenger.com/t/${t}`;
      log('Navigating to thread:', messengerUrl);
      try {
        await page.goto(messengerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        log('Navigation failed:', e.message || e);
      }

      const selector = await waitForInputSelector(page, 8000);
      if (!selector) {
        // screenshot for debugging
        const ssName = `screenshot_fail_${Date.now()}.png`;
        try { await page.screenshot({ path: ssName, fullPage: true }); log('Saved screenshot:', ssName); } catch(e){}
        log('Message input selector not found — cookie/session may be invalid or page layout changed.');
        TASK.progress.error = 'Message input not found — check cookie/login';
        continue;
      }
      log('Found input selector:', selector);

      // Sending according to mode
      if (mode === 'single' || mode === 'bulk') {
        for (const text of messages) {
          if (TASK.progress.stopped) break;
          log('Sending message to', t, '=>', text.substring(0,80));
          const ok = await sendOneMessage(page, selector, text);
          TASK.progress.lastResult = ok ? 'sent' : 'failed';
          TASK.progress.sentCount++;
          log('Result:', ok ? 'sent' : 'failed', 'total sent:', TASK.progress.sentCount);
          // wait
          const waitMs = delay;
          for (let w=0; w<waitMs; w+=500) { if (TASK.progress.stopped) break; await new Promise(r=>setTimeout(r, Math.min(500, waitMs-w))); }
        }
      } else if (mode === 'loop') {
        let idx = 0;
        while (!TASK.progress.stopped) {
          const text = messages[idx % messages.length];
          log('Loop send to', t, '=>', text.substring(0,80));
          const ok = await sendOneMessage(page, selector, text);
          TASK.progress.lastResult = ok ? 'sent' : 'failed';
          TASK.progress.sentCount++;
          log('Result:', ok ? 'sent' : 'failed', 'total sent:', TASK.progress.sentCount);
          // delay with stop checks
          const waitMs = delay;
          for (let w=0; w<waitMs; w+=500) { if (TASK.progress.stopped) break; await new Promise(r=>setTimeout(r, Math.min(500, waitMs-w))); }
          idx++;
        }
      }

      if (TASK.progress.stopped) break;
    }

    TASK.progress.done = true;
    log('Task complete. sentCount=', TASK.progress.sentCount);
  } catch (err) {
    log('Error during sending task:', err && err.message ? err.message : err);
    TASK.progress.error = String(err);
  } finally {
    try { await browser.close(); } catch (_) {}
    TASK.running = false;
  }
}

// API endpoints
app.post('/start', async (req, res) => {
  try {
    if (TASK.running) return res.status(409).json({ ok:false, error:'Task already running' });
    const { cookie, thread, delay, mode, messages, targets, headless } = req.body;
    if ((!messages || messages.length === 0) && !(req.body.message)) return res.status(400).json({ ok:false, error:'Missing messages' });
    // normalize messages
    let msgs = Array.isArray(messages) ? messages : (req.body.message ? [String(req.body.message)] : []);
    if (typeof msgs[0] === 'string') msgs = msgs.map(s => s.trim()).filter(Boolean);

    TASK.progress = { sentCount: 0, lastResult: null, stopped: false, logLines: LOGS, error: null, done:false };
    TASK.running = true;
    // run but don't await — respond immediately
    runSendingTask({ cookie, thread, delay, mode, messages: msgs, targets, headless }).catch(e => {
      log('runSendingTask error', e && e.message ? e.message : e);
    });
    res.json({ ok:true, msg:'Task started' });
  } catch (e) {
    log('Start endpoint error', e && e.message ? e.message : e);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/stop', (req, res) => {
  if (!TASK.running) return res.json({ ok:false, msg:'No running task' });
  TASK.progress.stopped = true;
  TASK.running = false;
  log('Stop requested by user');
  res.json({ ok:true });
});

app.get('/status', (req, res) => {
  res.json({ running: TASK.running, progress: TASK.progress, logs: LOGS.slice(-200) });
});

// debug route to download latest screenshot if present
app.get('/latest-screenshot', (req, res) => {
  const files = fs.readdirSync('.').filter(f => f.startsWith('screenshot_fail_')).sort();
  if (!files.length) return res.status(404).send('no screenshot');
  res.sendFile(path.join(process.cwd(), files[files.length-1]));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('Server listening on', PORT));
                      
