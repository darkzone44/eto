import express from "express";
import bodyParser from "body-parser";
import path from "path";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.post("/send", async (req, res) => {
  try {
    const { cookie, threadId, message, delay } = req.body;

    if (!cookie || !threadId || !message) {
      return res.json({ success: false, error: "Please fill all fields" });
    }

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Cookie": cookie });

    await page.goto(`https://www.facebook.com/messages/t/${threadId}`, {
      waitUntil: "networkidle2"
    });

    await page.waitForSelector('[role="textbox"]', { timeout: 15000 });
    await page.type('[role="textbox"]', message);
    await page.keyboard.press("Enter");

    if (delay) await new Promise(r => setTimeout(r, delay * 1000));

    await browser.close();

    res.json({ success: true, msg: "✅ Message Sent Successfully" });

  } catch (err) {
    res.json({ success: false, error: err.toString() });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Running on PORT ${PORT}`));
