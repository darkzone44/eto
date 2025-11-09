// server.js — reliable, clear errors, supports single/group/bulk/loop
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '6mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

let current = { running: false, progress: null };

// helper: parse cookie string "k=v; k2=v2"
function parseCookieString(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(';').map(p => {
    const s = p.trim();
    if (!s) return null;
    const idx = s.indexOf('=');
    if (idx === -1) return null;
    return {
      name: s.slice(0, idx).trim(),
      value: s.slice(idx+1).trim(),
      domain: '.facebook.com',
      path: '/',
      httpOnly: false,
      secure: true
    };
  }).filter(Boolean);
}

// find a usable Chrome binary path — prefer env CHROME_PATH, else rely on Puppeteer bundled executablePath.
async function getChromeExecutable() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Common Linux paths (Render / typical VPS)
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;

  // If puppeteer has a bundled executable path, return it if present
  try {
    const puppeteerPath = puppeteer.executablePath();
    if (puppeteerPath && fs.existsSync(puppeteerPath)) return puppeteerPath;
  } catch (e) {
    // ignore
  }
  return null;
}

async function waitForInputSelector(page) {
  const selectors = [
    'div[contenteditable="true"][role="combobox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  for (const sel of selectors) {
    try { await page.waitForSelector(sel, { timeout: 4000 }); return sel; } catch(e) {}
  }
  return null;
}

async function lastMessageTextInThread(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('div[dir="auto"], span, div')).slice(-30);
    for (let i = nodes.length-1; i>=0; i--) {
      const t = nodes[i].innerText;
      if (t && t.trim()) return t.trim();
    }
    return null;
  }).catch(()=>null);
}

async function sendOneMessage(page, selector, text) {
  try {
    const isCE = await page.evaluate(sel => {
      const e = document.querySelector(sel); return !!(e && e.isContentEditable);
    }, selector).catch(()=>false);

    if (isCE) {
      await page.evaluate((sel, msg) => {
        const e = document.querySelector(sel); if (!e) return;
        e.focus(); e.innerHTML = '';
        e.appendChild(document.createTextNode(msg));
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, selector, text);
      await page.keyboard.press('Enter');
    } else {
      await page.evaluate((sel, msg) => {
        const e = document.querySelector(sel); if (!e) return;
        e.value = msg; e.dispatchEvent(new Event('input', { bubbles: true }));
      }, selector, text);
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

// runTask supports single UID / group thread / bulk / loop modes
async function runTask(params, progress) {
  const cookies = parseCookieString(params.cookie || '');
  const chromePath = await getChromeExecutable();
  if (!chromePath) {
    throw new Error('No Chrome found. Set CHROME_PATH env or enable postinstall puppeteer install.');
  }

  progress.log(`Using Chrome binary: ${chromePath}`);
  const browser = await puppeteer.launch({
    headless: params.headless === true,
    executablePath: chromePath,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  try {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    if (cookies.length) await page.setCookie(...cookies);

    // mode handling:
    // - singleUID: params.target = <uid>, open messenger.com/t/<uid>
    // - groupThread: params.target = <threadId>, open messenger.com/t/<threadId>
    // - bulk: params.targets = [uid1,uid2,...] iterate over each
    // - autoLoop: loop on given target every delay
    const delay = Math.max(300, parseInt(params.delay || 3000, 10));
    const messages = params.messages || [];
    const maxsend = parseInt(params.maxsend || '0', 10);
    let sent = 0;

    // helper to send for a single opened thread
    const sendInCurrentThread = async () => {
      const selector = await waitForInputSelector(page);
      if (!selector) throw new Error('Message input not found — maybe cookie invalid or UI changed.');
      for (const text of messages) {
        if (progress.stopped) return;
        progress.log('Sending: ' + text.substring(0,100));
        const ok = await sendOneMessage(page, selector, text);
        progress.lastResult = ok ? 'sent' : 'failed';
        progress.sentCount = ++sent;
        if (!ok) progress.log('Send not confirmed for message: ' + text.substring(0,80));
        if (maxsend > 0 && sent >= maxsend) return;
        // delay with stop check
        const step=500; let w=0;
        while(!progress.stopped && w < delay) { await new Promise(r=>setTimeout(r, step)); w+=step; }
      }
    };

    if (params.mode === 'singleUID') {
      await page.goto(`https://www.messenger.com/t/${params.target}`, { waitUntil: 'domcontentloaded' });
      await sendInCurrentThread();
    } else if (params.mode === 'groupThread') {
      await page.goto(`https://www.messenger.com/t/${params.target}`, { waitUntil: 'domcontentloaded' });
      await sendInCurrentThread();
    } else if (params.mode === 'bulk') {
      const targets = params.targets || [];
      for (const t of targets) {
        if (progress.stopped) break;
        progress.log('Opening target: ' + t);
        await page.goto(`https://www.messenger.com/t/${t}`, { waitUntil: 'domcontentloaded' });
        await sendInCurrentThread();
        if (progress.stopped) break;
      }
    } else if (params.mode === 'autoLoop') {
      const target = params.target;
      await page.goto(`https://www.messenger.com/t/${target}`, { waitUntil: 'domcontentloaded' });
      while (!progress.stopped) {
        await sendInCurrentThread();
        if (progress.stopped) break;
      }
    } else {
      throw new Error('Unknown mode: ' + params.mode);
    }

    await browser.close();
    progress.done = true;
    return progress;
  } catch (err) {
    try { await browser.close(); } catch(_) {}
    progress.error = String(err);
    progress.done = true;
    return progress;
  }
}

// API endpoints
app.post('/start', async (req,res) => {
  if (current.running && current.progress && !current.progress.done) return res.status(409).json({ error: 'task running' });
  const { cookie, mode, target, targets, delay, messages, maxsend, headless } = req.body;
  if (!cookie || !mode || (!(target || targets) && mode !== 'bulk' && mode !== 'autoLoop' && mode !== 'singleUID' && mode !== 'groupThread')) {
    return res.status(400).json({ error: 'Missing required fields: cookie, mode, target/targets, messages' });
  }
  const prog = { stopped:false, sentCount:0, lastResult:null, logLines:[], done:false };
  prog.log = txt => { prog.logLines.push(`[${new Date().toISOString()}] ${txt}`); console.log(txt); };
  current = { running:true, progress:prog };

  // run async
  runTask({ cookie, mode, target, targets, delay, messages, maxsend, headless }).then(() => { current.running = false; }).catch(e => { prog.error = String(e); prog.done = true; current.running = false; });

  prog.log('Starting task ' + JSON.stringify({ mode, target, targets }));
  res.json({ ok:true });
});

app.post('/stop', (req,res) => {
  if (!current.running) return res.json({ ok:false, msg:'no task' });
  current.progress.stopped = true;
  res.json({ ok:true });
});

app.get('/status', (req,res) => {
  if (!current.progress) return res.json({ running:false });
  res.json({ running: current.running && !current.progress.done && !current.progress.stopped, progress: current.progress });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Server listening on', PORT));
