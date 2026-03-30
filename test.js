/*
  End-to-end test: simulates an agent that gets stuck and needs human rescue.

  Run:
    1. Start Pilot:  node server.js
    2. Run this:     node test.js
    3. Open the rescue link in your browser
    4. Click around, then hit "Done"
    5. This script unblocks and continues
*/

const puppeteer = require("puppeteer");
const pilot = require("./sdk")("http://localhost:3001");

async function main() {
  console.log("Agent starting...");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();

  // Agent does its thing
  console.log("Navigating to target...");
  await page.goto("https://httpbin.org/forms/post");
  console.log("Filling form...");
  await page.type('input[name="custname"]', "AI Agent");
  await page.click('input[value="medium"]');

  // Agent hits a wall — needs human help
  console.log("Stuck! Requesting human rescue...");
  const result = await pilot.rescue(page, "Fill in the rest of this form and submit it");

  if (result.solved) {
    console.log("Human solved it! Taking screenshot of result...");
    await page.screenshot({ path: "/tmp/pilot_after_rescue.jpg", type: "jpeg" });
    console.log("Saved to /tmp/pilot_after_rescue.jpg");
  } else {
    console.log("Timed out waiting for human.");
  }

  await browser.close();
  console.log("Done.");
}

main().catch(console.error);
