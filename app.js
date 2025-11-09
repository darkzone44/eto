const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve HTML UI
app.use(express.static(path.join(__dirname, "public")));

let task = { running:false, stop:false };

function parseCookies(str) {
  return str.split(";").map(p => {
    let [name, ...v] = p.trim().split("=");
    return { name, value: v.join("="), domain: ".facebook.com", path: "/" };
  });
}

async function sendMessages({ cookie, thread, messages, delay }) {
  task.running = true;
  task.stop = false;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  });

  const context = await browser.newContext();
  await context.addCookies(parseCookies(cookie));
  const page = await context.newPage();

  await page.goto(`https://www.messenger.com/t/${thread}`, { waitUntil: "domcontentloaded" });
  const inputSelector = `div[contenteditable="true"][role="textbox"]`;
  await page.waitForSelector(inputSelector);

  for (const msg of messages) {
    if (task.stop) break;
    await page.click(inputSelector);
    await page.type(inputSelector, msg);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(parseInt(delay));
  }

  await browser.close();
  task.running = false;
}

app.post("/start", (req, res) => {
  if (task.running) return res.json({ error: "Already running" });

  const { cookie, thread, messages, delay } = req.body;
  if (!cookie || !thread || !messages) return res.json({ error: "Missing fields" });

  sendMessages({ cookie, thread, messages, delay });
  res.json({ ok: true, running: true });
});

app.post("/stop", (req, res) => {
  task.stop = true;
  res.json({ ok: true });
});

app.get("/status", (req, res) => {
  res.json({ running: task.running });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`RUNNING ON PORT ${PORT}`));
