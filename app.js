import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "chromium";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/start", async (req, res) => {
  const { cookie, threadId, message, delay } = req.body;

  try {
    const browser = await puppeteer.launch({
      executablePath: chromium.path,
      headless: false, // ✅ AB OUTPUT DEKHEGA
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    // ✅ Set Cookie
    await page.setCookie(
      ...cookie.split(";").map(c => {
        const [name, ...val] = c.trim().split("=");
        return { name, value: val.join("="), domain: ".facebook.com" };
      })
    );

    // ✅ IMPORTANT: E2EE chats always open here
    await page.goto(`https://www.facebook.com/messages/t/${threadId}`, {
      waitUntil: "networkidle2"
    });

    // ✅ Wait for textbox
    await page.waitForSelector("div[aria-label='Message']", { timeout: 30000 });

    let sent = 0;

    const sendMessage = async () => {
      try {
        await page.type("div[aria-label='Message']", message);
        await page.keyboard.press("Enter");
        sent++;
        console.log("✅ Sent:", sent);
      } catch (e) {
        console.log("⚠️ Send Failed:", e.message);
      }
    };

    sendMessage();
    setInterval(sendMessage, Number(delay));

    res.json({ status: "Started Sending", check_console: true });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(10000, () => console.log("✅ Running on port 10000"));
