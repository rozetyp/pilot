/*
  Pilot SDK — one-line human rescue for Puppeteer and Playwright.

  Usage (Puppeteer):
    const pilot = require('./sdk')('http://localhost:3001');
    const result = await pilot.rescue(page, 'Solve the CAPTCHA');

  Usage (Playwright):
    const pilot = require('./sdk')('http://localhost:3001');
    const result = await pilot.rescue(page, 'Solve the CAPTCHA');
    // Same API — SDK auto-detects Playwright vs Puppeteer.
*/

module.exports = function createPilot(baseUrl = "http://localhost:3001") {

  // Detect Puppeteer vs Playwright and extract CDP endpoint
  function getConnectionInfo(page) {
    // Puppeteer: page.browser().wsEndpoint()
    if (typeof page.browser === "function") {
      const browser = page.browser();
      if (typeof browser.wsEndpoint === "function") {
        return {
          cdp_url: browser.wsEndpoint(),
          target_url: page.url(),
          type: "puppeteer",
        };
      }
    }

    // Playwright: page.context().browser().wsEndpoint() — only if connectOverCDP was used
    // For locally launched Playwright, CDP endpoint isn't always available
    if (typeof page.context === "function") {
      const ctx = page.context();
      if (typeof ctx.browser === "function") {
        const browser = ctx.browser();
        if (browser && typeof browser.wsEndpoint === "function") {
          return {
            cdp_url: browser.wsEndpoint(),
            target_url: page.url(),
            type: "playwright",
          };
        }
      }
    }

    return null;
  }

  async function rescue(page, context, { timeout = 600_000, poll = 1000, onRescueUrl } = {}) {
    let session_id;

    try {
      // 1. Get CDP connection info
      const connInfo = getConnectionInfo(page);

      let createBody;
      if (connInfo) {
        createBody = { cdp_url: connInfo.cdp_url, target_url: connInfo.target_url, context };
      } else {
        // No CDP endpoint available — launch local browser as fallback
        // The agent will need to re-navigate after rescue
        console.log("  Pilot: no CDP endpoint found, launching local browser");
        createBody = { headless: true, context };
      }

      const createRes = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        return { solved: false, error: "session_create_failed", detail: err };
      }
      session_id = (await createRes.json()).session_id;

      // 2. Get rescue link
      const rescueRes = await fetch(`${baseUrl}/sessions/${session_id}/rescue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      });
      if (!rescueRes.ok) {
        await cleanup(session_id);
        return { solved: false, error: "rescue_create_failed" };
      }
      const { pilot_url } = await rescueRes.json();

      console.log(`\n  Pilot: agent needs help — "${context}"`);
      console.log(`  ${pilot_url}\n`);

      if (onRescueUrl) {
        try { await onRescueUrl(pilot_url, context); } catch {}
      }

      // 3. Poll until resolved
      const deadline = Date.now() + timeout;
      let consecutiveErrors = 0;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, poll));

        try {
          const statusRes = await fetch(`${baseUrl}/sessions/${session_id}`);

          if (statusRes.status === 404) {
            return { solved: false, session_id, pilot_url, error: "session_lost" };
          }

          const data = await statusRes.json();

          if (data.status === "RUNNING") {
            await cleanup(session_id);
            return { solved: true, session_id, pilot_url };
          }

          if (data.status === "DEAD") {
            await cleanup(session_id);
            return { solved: false, session_id, pilot_url, error: "browser_died" };
          }

          consecutiveErrors = 0;
        } catch {
          consecutiveErrors++;
          if (consecutiveErrors >= 10) {
            return { solved: false, session_id, pilot_url, error: "server_unreachable" };
          }
        }
      }

      await cleanup(session_id);
      return { solved: false, session_id, pilot_url, error: "timeout" };

    } catch (e) {
      if (session_id) await cleanup(session_id);
      return { solved: false, session_id, error: "unexpected", detail: e.message };
    }
  }

  async function cleanup(session_id) {
    try { await fetch(`${baseUrl}/sessions/${session_id}`, { method: "DELETE" }); } catch {}
  }

  return { rescue };
};
