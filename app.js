const express = require("express");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");

let browser;
let page;
let isRunning = false;
let sentCount = 0;

async function loginWithCookie(cookie) {
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();

    await page.goto("https://www.facebook.com/");

    const cookieParts = cookie.split(";").map(c => {
        const [name, value] = c.trim().split("=");
        return { name, value, domain: ".facebook.com" };
    });

    await page.context().addCookies(cookieParts);
    await page.goto("https://www.facebook.com/messages");
    await page.waitForTimeout(4000);
}

async function sendMessageToThread(threadID, message) {
    await page.goto(`https://www.facebook.com/messages/t/${threadID}`);
    await page.waitForSelector('[contenteditable="true"]');
    await page.type('[contenteditable="true"]', message);
    await page.keyboard.press("Enter");
    sentCount++;
}

async function startTask(mode, target, message, delay, bulkList) {
    isRunning = true;

    if (mode === "singleUID") {
        await sendMessageToThread(target, message);

    } else if (mode === "group") {
        await sendMessageToThread(target, message);

    } else if (mode === "bulk") {
        for (const uid of bulkList) {
            if (!isRunning) break;
            await sendMessageToThread(uid, message);
            await page.waitForTimeout(1500);
        }

    } else if (mode === "loop") {
        while (isRunning) {
            await sendMessageToThread(target, message);
            await page.waitForTimeout(delay);
        }
    }
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(__dirname));

app.post("/login", async (req, res) => {
    try {
        await loginWithCookie(req.body.cookie);
        res.send({ ok: true });
    } catch (e) {
        res.send({ ok: false, error: e.toString() });
    }
});

app.post("/start", async (req, res) => {
    const { mode, target, message, delay, bulk } = req.body;
    sentCount = 0;

    startTask(mode, target, message, delay, bulk);
    res.send({ ok: true });
});

app.post("/stop", (req, res) => {
    isRunning = false;
    res.send({ ok: true });
});

app.get("/status", (req, res) => {
    res.send({ running: isRunning, sent: sentCount });
});

app.listen(3000, () => console.log("✅ Server Running: http://localhost:3000")); 
