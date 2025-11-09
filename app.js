import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fetch from "node-fetch";
import puppeteer from "puppeteer";

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
      return res.json({ success: false, error: "Missing fields" });
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      "Cookie": cookie
    });

    await page.goto(`https://www.facebook.com/messages/t/${threadId}`, {
      waitUntil: "networkidle2"
    });

    await page.waitForSelector('[role="textbox"]');
    await page.type('[role="textbox"]', message);
    await page.keyboard.press("Enter");

    if (delay) await new Promise(r => setTimeout(r, delay * 1000));

    await browser.close();

    return res.json({ success: true, message: "Message sent successfully ✅" });

  } catch (err) {
    return res.json({ success: false, error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
