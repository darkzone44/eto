/**
 * fb-messenger-automation (enhanced)
 * - Real message sending with retries and DOM-confirmation
 * - Usage: node index.js --cookie "..." --thread 61564176744081 --messages messages.txt --delay 3000 --mode once
 *
 * Modes:
 *  - mode=once        -> send each message from file once, then exit
 *  - mode=loop        -> loop messages indefinitely until stopped
 *
 * Controls:
 *  - Type 's' + ENTER to stop during run.
 *
 * WARNING: Use only with your own account. Avoid spamming.
 */

const fs = require('fs');
const puppeteer = require('puppeteer');
const minimist = require('minimist');
const readline = require('readline');

const args = minimist(process.argv.slice(2), {
  string: ['cookie', 'thread', 'messages', 'delay', 'headless', 'mode', 'logfile', 'maxsend'],
  alias: { c: 'cookie', t: 'thread', m: 'messages', d: 'delay', h: 'headless' },
  default: { delay: '3000', headless: 'false', messages: 'messages.txt', mode: 'once', logfile: 'send.log', maxsend: '0' }
});

if (!args.cookie) { console.error('Error: --cookie is required'); process.exit(1); }
if (!args.thread) { console.error('Error: --thread is required'); process.exit(1); }

const COOKIE_STRING = args.cookie;
const THREAD_ID = args.thread;
const MESSAGES_FILE = args.messages;
const DELAY_MS = Math.max(500, parseInt(args.delay || '3000', 10));
const HEADLESS = (args.headless === 'true');
const MODE = args.mode === 'loop' ? 'loop' : 'once';
const LOGFILE = args.logfile;
const MAX_SEND = parseInt(args.maxsend || '0', 10); // 0 = unlimited (subject to mode)

function log(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch (e) {}
}

function parseCookieString(cookieStr, domain = '.facebook.com') {
  return cookieStr.split(';').map(pair => {
    const p = pair.trim();
    if (!p) return null;
    const eq = p.indexOf('=');
    if (eq === -1) return null;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!name) return null;
    return { name, value, domain, path: '/', httpOnly: false, secure: true };
  }).filter(Boolean);
}

async function waitForInputSelectors(page) {
  const candidates = [
    'div[contenteditable="true"][role="combobox"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  for (const sel of candidates) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      const el = await page.$(sel);
      if (el) return sel;
    } catch (e) {}
  }
  return null;
}

async function sendViaContentEditable(page, selector, text) {
  // Try to set contenteditable text and press Enter
  return page.evaluate(async (sel, msg) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, err: 'noel' };
    el.focus();
    // Clear
    el.innerHTML = '';
    // Insert text node
    const tn = document.createTextNode(msg);
    el.appendChild(tn);
    // Dispatch input event
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Press Enter
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' });
    el.dispatchEvent(e);
    const e2 = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' });
    el.dispatchEvent(e2);
    return { ok: true };
  }, selector, text);
}

async function sendViaTextarea(page, selector, text) {
  const el = await page.$(selector);
  if (!el) throw new Error('textarea not found');
  await el.click({ clickCount: 3 });
  await page.evaluate((sel, msg) => {
    const e = document.querySelector(sel);
    e.value = msg;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, text);
  // Try press Enter
  await page.keyboard.press('Enter');
}

async function clickSendButtonIfAny(page) {
  // Try known send button selectors
  const btnSelectors = [
    'a[aria-label="Send"]',
    'button[aria-label="Send"]',
    'div[aria-label="Press Enter to send"]', // fallback
    'div[role="button"][aria-label*="Send"]'
  ];
  for (const bsel of btnSelectors) {
    const b = await page.$(bsel);
    if (b) { try { await b.click(); return true; } catch (e){} }
  }
  return false;
}

async function lastMessageTextInThread(page) {
  // Find last message text bubble from "you"
  return page.evaluate(() => {
    // messenger.com structure: messages appear as divs; find last outgoing bubble
    const out = Array.from(document.querySelectorAll('[data-sigil="message-text"], [data-testid="message-text"], div[dir="auto"]')).slice(-6);
    if (!out || out.length === 0) {
      const all = Array.from(document.querySelectorAll('div[role="row"] span, div[role="row"] div'));
      if (all.length === 0) return null;
      return all[all.length-1].innerText || null;
    }
    // take last candidate with text
    for (let i = out.length-1; i>=0; i--) {
      const t = out[i].innerText;
      if (t && t.trim()) return t.trim();
    }
    return null;
  });
}

async function sendOneMessage(page, inputSelector, text, attempt = 1) {
  try {
    // prefer contenteditable method if selector is contenteditable
    const isContentEditable = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!(el && el.isContentEditable);
    }, inputSelector).catch(()=>false);

    if (isContentEditable) {
      await sendViaContentEditable(page, inputSelector, text);
    } else {
      // textarea / input fallback
      await sendViaTextarea(page, inputSelector, text);
      // maybe click send button
      await clickSendButtonIfAny(page);
    }

    // Wait short while then confirm last message matches
    const confirmWaitMs = 4000;
    const start = Date.now();
    while (Date.now() - start < confirmWaitMs) {
      const last = await lastMessageTextInThread(page);
      if (last && last.includes(text.substring(0, Math.min(40, text.length)))) {
        return { ok: true };
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // If not confirmed, try clicking send button as backup
    await clickSendButtonIfAny(page);

    // final check
    const final = await lastMessageTextInThread(page);
    if (final && final.includes(text.substring(0, Math.min(40, text.length)))) {
      return { ok: true };
    }

    // if still not sent and attempts left, retry
    if (attempt < 3) {
      log('Retrying send attempt', attempt+1);
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return await sendOneMessage(page, inputSelector, text, attempt+1);
    }

    return { ok: false, err: 'not_confirmed' };
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return await sendOneMessage(page, inputSelector, text, attempt+1);
    }
    return { ok: false, err: e.message || String(e) };
  }
}

async function main() {
  const cookies = parseCookieString(COOKIE_STRING);
  log(`Parsed ${cookies.length} cookies. Launching browser headless=${HEADLESS}`);
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
    defaultViewport: null
  });
  const page = await browser.newPage();

  // go to facebook to set cookies
  try { await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch(e){}

  await page.setCookie(...cookies.map(c => ({...c, domain: '.facebook.com'})));
  const messengerUrl = `https://www.messenger.com/t/${THREAD_ID}`;
  log('Navigating to', messengerUrl);
  await page.goto(messengerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Quick login check: presence of contenteditable
  let inputSelector = await waitForInputSelectors(page);
  if (!inputSelector) {
    log('Input selector not found. Taking screenshot to messenger_page.png and exiting.');
    await page.screenshot({ path: 'messenger_page.png', fullPage: true });
    await browser.close();
    process.exit(1);
  }
  log('Found input selector:', inputSelector);

  // Load messages
  let messages = [];
  try {
    messages = fs.readFileSync(MESSAGES_FILE, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (messages.length === 0) throw new Error('empty');
  } catch (e) {
    log('Failed reading messages file:', MESSAGES_FILE);
    await browser.close();
    process.exit(1);
  }
  log(`Loaded ${messages.length} messages. Mode=${MODE}. Delay=${DELAY_MS}ms`);

  // readline control
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stopped = false;
  rl.on('line', (ln) => { if (ln.trim().toLowerCase() === 's') { stopped = true; log('Stop requested'); } });

  log("Type 's' + ENTER anytime to stop. Press ENTER to begin.");
  await new Promise(res => rl.question('Press ENTER to start: ', () => res()));

  let sentCount = 0;
  let idx = 0;
  while (!stopped) {
    if (MAX_SEND > 0 && sentCount >= MAX_SEND) {
      log('Reached max send count', MAX_SEND);
      break;
    }

    const text = messages[idx % messages.length];
    log(`Sending #${sentCount+1} -> "${text.substring(0,80)}"${text.length>80? '...':''}`);
    const res = await sendOneMessage(page, inputSelector, text);
    if (res.ok) {
      sentCount++;
      log('Send confirmed. Total sent:', sentCount);
    } else {
      log('Send failed:', res.err);
      // decide: continue or exit; we'll continue but after capturing screenshot
      try { await page.screenshot({ path: `fail_send_${Date.now()}.png`, fullPage: true }); } catch(e){}
    }

    // advance
    idx++;
    if (MODE === 'once' && idx >= messages.length) {
      log('Mode once complete. Exiting.');
      break;
    }

    // wait with stop checks
    const step = 500;
    let waited = 0;
    while (!stopped && waited < DELAY_MS) {
      await new Promise(r=>setTimeout(r, step));
      waited += step;
    }
  }

  log('Finished run. Closing browser.');
  rl.close();
  await browser.close();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
      
