/*
  Demo script for recording.

  Shows: Agent navigates → hits hCaptcha → rescue link → human solves → agent continues.

  Run:
    node server.js &
    node demo.js

  Record your screen (terminal + browser side by side).
*/

const puppeteer = require("puppeteer");
const pilot = require("./sdk")("http://localhost:3001");

(async () => {
  console.log("");
  console.log("  Agent: launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();

  console.log("  Agent: navigating to htsapi.dev...");
  await page.goto("https://htsapi.dev");

  console.log("  Agent: clicking Classify...");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Classify"));
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 2000));

  console.log("  Agent: hCaptcha detected! Requesting human help...");
  console.log("");

  const result = await pilot.rescue(page, "Solve the hCaptcha and click Classify");

  if (result.solved) {
    console.log("  Agent: human solved it! Continuing...");
    const title = await page.title();
    console.log("  Agent: page title:", title);
    console.log("");
    console.log("  Done.");
  } else {
    console.log("  Agent: no human responded. Error:", result.error);
  }

  await browser.close();
})();
