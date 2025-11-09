const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ensure root serves index.html to avoid "Cannot GET /"
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

let current = { running: false, progress: null };

function parseCookieString(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(';').map(pair => {
    const p = pair.trim();
    if (!p) return null;
    const idx = p.indexOf('=');
    if (idx === -1) return null;
    const name = p.slice(0, idx).trim();
    const value = p.slice(idx+1).trim();
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
    const nodes = Array.from(document.querySelectorAll('div[dir="auto"], span, div')).slice(-20);
    for (let i = nodes.length-1; i>=0; i--) {
      const t = nodes[i].innerText;
      if (t && t.trim()) return t.trim();
    }
    return null;
  }).catch(()=>null);
}

async function sendOneMessage(page, selector, text) {
  try {
    const isCE = await page.evaluate(sel => { const e = document.querySelector(sel); return !!(e && e.isContentEditable); }, selector).catch(()=>false);
    if (isCE) {
      await page.evaluate((sel, msg) => {
        const e = document.querySelector(sel); if(!e) return;
        e.focus(); e.innerHTML = '';
        e.appendChild(document.createTextNode(msg));
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, selector, text);
      await page.keyboard.press('Enter');
    } else {
      await page.evaluate((sel, msg)=>{ const e=document.querySelector(sel); if(e){ e.value = msg; e.dispatchEvent(new Event('input', { bubbles:true })); } }, selector, text);
      await page.keyboard.press('Enter');
    }

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const last = await lastMessageTextInThread(page);
      if (last && last.includes(text.substring(0, Math.min(text.length, 40)))) return true;
      await new Promise(r=>setTimeout(r, 400));
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function runTask(params, progress) {
  const cookies = parseCookieString(params.cookie || '');
  const chromePath = process.env.CHROME_PATH || params.chromePath || '/usr/bin/google-chrome-stable';
  const launchOpts = { headless: params.headless === true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] };
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  try {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    if (cookies.length) await page.setCookie(...cookies);
    const messengerUrl = `https://www.messenger.com/t/${params.thread}`;
    await page.goto(messengerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const selector = await waitForInputSelector(page);
    if (!selector) throw new Error('Message input not found');

    let sent = 0;
    let idx = 0;
    const messages = params.messages || [];
    const delay = Math.max(300, parseInt(params.delay || 3000, 10));
    const maxsend = parseInt(params.maxsend || '0', 10);

    while (!progress.stopped) {
      if (maxsend > 0 && sent >= maxsend) break;
      if (!messages.length) break;
      const text = messages[idx % messages.length];
      progress.log(`Sending: ${text.substring(0,80)}...`);
      const ok = await sendOneMessage(page, selector, text);
      progress.lastResult = ok ? 'sent' : 'failed';
      progress.sentCount = ++sent;

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

app.post('/start', (req, res) => {
  if (current.running && current.progress && !current.progress.done) return res.status(409).json({ error: 'task running' });
  const { cookie, thread, delay, headless, mode, messages, maxsend, chromePath } = req.body;
  if (!cookie || !thread || !messages) return res.status(400).json({ error: 'missing cookie/thread/messages' });

  const progress = { stopped: false, sentCount: 0, lastResult: null, logLines: [], done: false };
  progress.log = txt => { progress.logLines.push(`[${new Date().toISOString()}] ${txt}`); console.log(txt); };
  current = { running: true, progress };

  // run async
  runTask({ cookie, thread, delay, headless, mode, messages, maxsend, chromePath }, progress).then(() => { current.running = false; }).catch(err => { progress.error = String(err); progress.done = true; current.running = false; });

  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  if (!current.running) return res.json({ ok: false, msg: 'no task' });
  current.progress.stopped = true;
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  if (!current.progress) return res.json({ running: false });
  res.json({ running: current.running && !current.progress.done && !current.progress.stopped, progress: current.progress });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
      
