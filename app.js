const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

let current = { running: false, progress: null };

function parseCookieString(cookieStr) {
  return cookieStr.split(';').map(c=>{
    const [name, ...rest] = c.trim().split('=');
    return { name, value: rest.join('='), domain: '.facebook.com', path: '/' };
  });
}

async function runTask(params, progress) {
  const cookies = parseCookieString(params.cookie);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await page.setCookie(...cookies);
    await page.goto(`https://www.messenger.com/t/${params.thread}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[contenteditable="true"]');

    const messages = params.messages;
    const delay = parseInt(params.delay);
    for (let msg of messages) {
      await page.type('div[contenteditable="true"]', msg);
      await page.keyboard.press('Enter');
      progress.sent = (progress.sent||0)+1;
      await new Promise(r=>setTimeout(r, delay));
      if(progress.stop) break;
    }
    await browser.close();
    progress.done = true;
  } catch(err) {
    progress.error = String(err);
    try{ await browser.close(); }catch{}
  }
}

app.post('/start', (req,res)=>{
  if(current.running) return res.json({error:"Already running"});
  const {cookie, thread, delay, messages} = req.body;
  if(!cookie || !thread || !messages) return res.json({error:"Missing fields"});

  const progress = {sent:0, done:false};
  current = {running:true, progress};
  runTask(req.body, progress).then(()=>{ current.running=false; });
  res.json({ok:true});
});

app.post('/stop',(req,res)=>{
  if(current.progress) current.progress.stop = true;
  res.json({ok:true});
});

app.get('/status',(req,res)=>{
  res.json({running:current.running, progress:current.progress});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log("Running on", PORT));
