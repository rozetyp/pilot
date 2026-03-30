# Pilot

Human rescue for AI browser agents. When your agent gets stuck — CAPTCHA, login, 2FA, unexpected modal — one function call gets a human to solve it.

**[See how it works (interactive demo)](https://rozetyp.github.io/pilot/demo.html)**

```python
# Browser Use
from browser_use_plugin import create_pilot_tools

tools = create_pilot_tools()
agent = Agent(task="...", llm=llm, tools=tools)
await agent.run()
# Agent hits a CAPTCHA → Pilot generates a rescue URL → human solves it → agent continues
```

```js
// Puppeteer
const pilot = require('./sdk')('http://localhost:3001');
await pilot.rescue(page, 'Solve the CAPTCHA');
// blocks until human solves it — page is ready, continue
```

## How it works

1. Agent calls `rescue()` (or the LLM calls `request_human_help`)
2. Pilot connects to the agent's browser via CDP
3. A rescue URL is generated — human opens it in their browser
4. Human sees a **live video stream** of the page, can click, type, scroll, drag
5. Human clicks **Done** — agent unblocks and continues

The agent's code doesn't change. The page state is preserved. The human solves whatever is blocking, and the agent picks up where it left off.

## Why not just use a CAPTCHA solver?

CAPTCHA solvers (2Captcha, CapSolver) only solve CAPTCHAs. Pilot handles **anything** a human can do in a browser:

- CAPTCHAs (hCaptcha, reCAPTCHA, Cloudflare Turnstile)
- Login with real credentials
- Two-factor authentication / SMS codes
- Cookie consent modals
- Age verification gates
- OAuth flows that break
- "Select the right image" challenges
- Unexpected UI changes the agent doesn't recognize
- Anything else — if a human can see it and click it, Pilot handles it

## Quick start

### 1. Start the Pilot server

```bash
cd pilot
npm install
node server.js
# Pilot v0.6 running on http://localhost:3001
```

### 2a. Browser Use (Python)

```bash
pip install browser-use httpx
# Copy browser_use_plugin.py into your project from this repo
```

```python
import asyncio
from browser_use import Agent, Browser
from browser_use.llm import ChatOpenAI
from browser_use_plugin import create_pilot_tools

async def main():
    tools = create_pilot_tools()  # connects to localhost:3001
    llm = ChatOpenAI(model="gpt-4o")

    agent = Agent(
        task="Go to https://example.com and do something that requires login",
        llm=llm,
        browser=Browser(),
        tools=tools,
    )
    await agent.run()

asyncio.run(main())
```

The LLM agent will automatically call `request_human_help` when it encounters something it can't solve. A rescue URL prints to your terminal. Open it, solve the problem, click Done.

### 2b. Puppeteer (Node.js)

```js
const puppeteer = require('puppeteer');
const pilot = require('./sdk')('http://localhost:3001');

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.goto('https://example.com/login');

// Agent does its thing...
// Hits a wall:
const result = await pilot.rescue(page, 'Please log in');
// Blocks here. Human opens rescue URL, logs in, clicks Done.

if (result.solved) {
    // Page is now logged in. Continue.
    await page.goto('https://example.com/dashboard');
}

await browser.close();
```

## Rescue UI

When a human opens the rescue URL, they see:

- **Live video stream** of the browser page (~10-15 fps via CDP screencast)
- **Click anywhere** on the page — coordinates are relayed to the real browser
- **Type** via text input or directly with keyboard (click the screen area first to focus)
- **Scroll** with mouse wheel
- **Drag** for slider CAPTCHAs (click and drag draws a line, released = smooth drag replay)
- **Keyboard shortcuts** — Tab, Enter, Escape, arrow keys forwarded automatically
- **Context message** — what the agent needs help with, shown in yellow at the top
- **Timer** — how long the rescue has been open
- **Done button** — hands control back to the agent

## Browser compatibility

| Browser runtime | Status | Notes |
|---|---|---|
| Puppeteer | Tested | Full CDP, streaming, auto-detected by SDK |
| Playwright + Chromium | Tested | Launch with `--remote-debugging-port`, pass CDP URL |
| Browser Use | Tested | Via plugin, auto-detects CDP from BrowserSession |
| Browserless | Tested | Single-connection mode works. Lower fps due to network hops. |
| Browserbase | Tested | Streaming works, supports multiple CDP connections. Lower fps when Pilot runs locally (network hops). |
| Playwright + Firefox/WebKit | No | No CDP support |

**Playwright note:** Playwright doesn't expose `wsEndpoint` on locally launched browsers. To use Pilot with standalone Playwright, launch with `--remote-debugging-port=9222` and fetch the CDP URL from `http://localhost:9222/json/version`.

**Browserless note:** Browserless allows only one CDP connection at a time. If your agent is already connected via Puppeteer, Pilot's second connection will drop the first. Use Pilot as the sole CDP client, or have the agent disconnect before calling rescue.

## SDK reference

### Node.js — `sdk.js`

```js
const pilot = require('./sdk')('http://localhost:3001');
const result = await pilot.rescue(page, 'context message', {
    timeout: 600_000,   // max wait (default 10min)
    poll: 1000,         // poll interval ms (default 1s)
    onRescueUrl: (url, context) => { /* notify Slack, etc */ },
});
// result.solved === true/false
// result.error === 'timeout' | 'browser_died' | 'session_lost' | ...
```

### Python — `browser_use_plugin.py`

```python
from browser_use_plugin import create_pilot_tools

tools = create_pilot_tools(
    pilot_url="http://localhost:3001",  # self-hosted (default)
    # pilot_url="https://api.getpilot.dev",  # hosted
    # api_key="pk_live_...",                  # for hosted
    timeout=600,          # seconds
    poll_interval=1.0,    # seconds
    on_rescue_url=None,   # async callback(url, reason)
)
# Pass to: Agent(tools=tools)
```

## API

All endpoints are on the Pilot server (`localhost:3001` by default).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/sessions` | Create session (CDP or local browser) |
| `GET` | `/sessions/:id` | Get status (also heartbeat) |
| `POST` | `/sessions/:id/act` | Execute action (click, type, scroll, etc.) |
| `POST` | `/sessions/:id/rescue` | Generate rescue link, start streaming |
| `POST` | `/sessions/:id/resume` | Human is done, unblock agent |
| `GET` | `/sessions/:id/screenshot` | One-off screenshot (fallback) |
| `DELETE` | `/sessions/:id` | Close session |
| `GET` | `/health` | Server health check |

### Actions (`POST /sessions/:id/act`)

| action | params | description |
|---|---|---|
| `click_coords` | `x, y` | Click at coordinates |
| `click` | `selector` | Click CSS selector |
| `type` | `selector, text` | Type into selector |
| `type_focused` | `text` | Type into focused element |
| `key` | `key` | Press key (Tab, Enter, Escape, etc.) |
| `scroll` | `x, y, deltaX, deltaY` | Mouse wheel scroll |
| `drag` | `x, y, toX, toY` | Smooth drag with eased movement |
| `navigate` | `url` | Go to URL |
| `screenshot` | — | Take screenshot |

## Security

- Rescue links are **HMAC-signed** with 10-minute expiry
- During rescue, the **token gates all action endpoints** — you can't control the browser without the rescue token
- Token is cleared on resume
- Set `PILOT_SECRET` env var for token stability across server restarts
- For production: run behind HTTPS reverse proxy

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3001 | Server port |
| `PILOT_SECRET` | random | HMAC signing key for rescue tokens |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL for rescue links (set to public domain in production) |

## Self-hosted vs hosted

Pilot is fully self-hosted and free. A hosted version is planned for teams that need public rescue URLs (reachable from phone/tablet), Slack/Discord notifications, team routing, and a dashboard of pending rescues.

The plugin will accept a `pilot_url` parameter to point at the hosted API when it's available.

## Notifications (self-hosted)

By default, rescue URLs print to stdout. Use the `on_rescue_url` callback to send them anywhere:

```python
import httpx

SLACK_WEBHOOK = "https://hooks.slack.com/services/T.../B.../..."

async def notify_slack(url, reason):
    async with httpx.AsyncClient() as client:
        await client.post(SLACK_WEBHOOK, json={
            "text": f"Agent needs help: {reason}\n{url}"
        })

tools = create_pilot_tools(on_rescue_url=notify_slack)
```

Works with any notification system — Slack, Discord, email, PagerDuty, SMS via Twilio, or a custom dashboard.

## Deterministic escalation

The LLM decides when to call `request_human_help`, but LLMs don't always know they're stuck. For reliable escalation, use Browser Use's `on_step_end` hook to auto-escalate after repeated failures:

```python
from browser_use_plugin import create_pilot_tools

tools = create_pilot_tools()

async def auto_escalate(agent):
    """If agent has failed 3+ consecutive steps, force a rescue."""
    history = agent.history
    if len(history) < 3:
        return

    recent_errors = [h for h in history[-3:] if h.result and not h.result[0].success]
    if len(recent_errors) >= 3:
        # Agent is stuck — trigger rescue directly
        # The LLM will see the request_human_help tool and use it next step
        agent.task.add_message(
            "You have failed 3 times in a row. Use request_human_help immediately."
        )

agent = Agent(task="...", llm=llm, tools=tools)
await agent.run(on_step_end=auto_escalate)
```

This catches the 11% of cases where the agent doesn't know it's failing.

## Tested against

- hCaptcha on htsapi.dev (interactive image challenge)
- LinkedIn login (credentials + potential CAPTCHA)
- httpbin forms (click, type, radio buttons, checkboxes)
- Slider CAPTCHAs (drag relay with eased mouse movement)
- Animated challenges (live streaming via CDP screencast)
- Wikipedia (mouse wheel scrolling)
