import express from "express";
import chromium from "chromium";
import puppeteer from "puppeteer-core";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/start", async (req, res) => {
  const { cookie, threadId, message, delay } = req.body;

  if (!cookie || !threadId || !message || !delay) {
    return res.json({ error: "Missing required fields" });
  }

  try {
    const browser = await puppeteer.launch({
      executablePath: chromium.path,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: true
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/127 Safari/537.36"
    );

    await page.setCookie(...cookie.split(";").map(c => {
      let [name, value] = c.trim().split("=");
      return { name, value, domain: ".facebook.com" };
    }));

    await page.goto(`https://www.messenger.com/t/${threadId}`, {
      waitUntil: "networkidle2"
    });

    let sent = 0;
    const interval = setInterval(async () => {
      try {
        await page.type('[contenteditable="true"]', message);
        await page.keyboard.press("Enter");
        sent++;
        console.log(`Message Sent: ${sent}`);
      } catch (err) {
        console.log("Send failed:", err.message);
      }
    }, delay);

    res.json({ status: "running", message: "Message sending started." });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(10000, () => console.log("✅ Server Started on Port 10000"));
