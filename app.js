const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(cors());
app.use(bodyParser.json({limit: '5mb'}));

let running = false;
let browser = null;
let page = null;

function parseCookieString(cookieStr) {
  return cookieStr.split(';').map(c => {
    const [name, ...rest] = c.trim().split('=');
    return { name, value: rest.join('='), domain: '.facebook.com' };
  });
}

async function startBot({ cookie, threadId, delay, messages }) {
  const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
  browser = await puppeteer.launch({
    executablePath,
    headless: false,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  page = await browser.newPage();
  await page.setCookie(...parseCookieString(cookie));
  await page.goto(`https://www.facebook.com/messages/t/${threadId}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('div[contenteditable="true"]', { timeout: 20000 });

  let msgs = messages;
  running = true;
  while (running) {
    for (let msg of msgs) {
      if (!running) break;
      const box = await page.$('div[contenteditable="true"]');
      await box.focus();
      await page.keyboard.type(msg);
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

app.post('/start', async (req, res) => {
  if (running) return res.json({ status: 'already running' });
  const { cookie, threadId, delay, messages } = req.body;
  startBot({ cookie, threadId, delay: Number(delay), messages }).catch(console.error);
  res.json({ status: 'started' });
});

app.post('/stop', async (req, res) => {
  running = false;
  try { if (browser) await browser.close(); } catch(e){}
  browser = null;
  res.json({ status: 'stopped' });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
