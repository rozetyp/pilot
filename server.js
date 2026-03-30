/*
  Pilot v0.6 — Human rescue for AI agents

  One-line SDK:  await pilot.rescue(page, "Solve the CAPTCHA")

  v0.6:
    - Mouse wheel relay via CDP Input.dispatchMouseEvent
    - Rescue token gates action endpoints during PAUSED state
    - (v0.5) Page targeting, keyboard forwarding, error toasts, heartbeat, streaming + fallback
*/

const express = require("express");
const http = require("http");
const puppeteer = require("puppeteer");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3001;
const SECRET = process.env.PILOT_SECRET || crypto.randomBytes(32).toString("hex");

// --- State ---
const sessions = new Map();

// --- Token utils ---

function generateToken(sessionId) {
  const expiresAt = Date.now() + 600_000;
  const payload = `${sessionId}|${expiresAt}`;
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}|${sig}`).toString("base64url");
}

function verifyToken(token) {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const [sessionId, expiresAt, sig] = raw.split("|");
    if (!sessionId || !expiresAt || !sig) return null;
    if (Date.now() > parseInt(expiresAt)) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${sessionId}|${expiresAt}`).digest("hex");
    if (sig !== expected) return null;
    return { sessionId };
  } catch { return null; }
}

// --- CDP screencast ---

async function startScreencast(session) {
  // Clean up any existing screencast first (fixes re-rescue bug)
  await stopScreencast(session);

  try {
    const cdp = await session.page.createCDPSession();
    session.cdp = cdp;
    session.watchers = new Set();
    session.screencastActive = true;

    cdp.on("Page.screencastFrame", async ({ data, sessionId: frameId }) => {
      cdp.send("Page.screencastFrameAck", { sessionId: frameId }).catch(() => {});
      for (const ws of session.watchers) {
        if (ws.readyState === 1) ws.send(data);
      }
    });

    cdp.on("CDPSession.Disconnected", () => {
      session.screencastActive = false;
      if (session.watchers) {
        for (const ws of session.watchers) {
          if (ws.readyState === 1) ws.send("__DEAD__");
        }
      }
    });

    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
  } catch (e) {
    console.log(`[screencast] Failed to start: ${e.message}`);
    session.screencastActive = false;
  }
}

async function stopScreencast(session) {
  session.screencastActive = false;
  if (session.cdp) {
    await session.cdp.send("Page.stopScreencast").catch(() => {});
    await session.cdp.detach().catch(() => {});
    session.cdp = null;
  }
  if (session.watchers) {
    for (const ws of session.watchers) ws.close();
    session.watchers = null;
  }
}

// --- WebSocket server ---

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session");
  const token = url.searchParams.get("token");

  const tokenData = verifyToken(token);
  if (!tokenData || tokenData.sessionId !== sessionId) {
    ws.close(4001, "Invalid token");
    return;
  }

  const s = sessions.get(sessionId);
  if (!s || !s.watchers) {
    ws.close(4004, "Session not found");
    return;
  }

  s.watchers.add(ws);
  ws.on("close", () => s.watchers?.delete(ws));

  if (!s.screencastActive) {
    ws.send("__DEAD__");
  } else {
    // Send an immediate screenshot so the human doesn't stare at black
    // while waiting for the first screencast frame
    s.page.screenshot({ encoding: "base64", type: "jpeg", quality: 60 })
      .then(data => { if (ws.readyState === 1) ws.send(data); })
      .catch(() => {});
  }
});

// --- API ---

// Create session with optional page targeting
app.post("/sessions", async (req, res) => {
  const { cdp_url, headless = true, viewport, context, target_url } = req.body;
  const id = "pilot_" + crypto.randomBytes(6).toString("hex");

  try {
    let browser, page, mode;

    if (cdp_url) {
      browser = await puppeteer.connect({ browserWSEndpoint: cdp_url });
      const pages = await browser.pages();

      if (target_url) {
        // Find the tab matching the URL
        page = pages.find(p => p.url().includes(target_url)) || pages[0];
      } else {
        page = pages[0] || await browser.newPage();
      }
      mode = "cdp";
    } else {
      browser = await puppeteer.launch({
        headless: headless ? "new" : false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      page = await browser.newPage();
      mode = "local";
    }

    if (viewport) await page.setViewport(viewport);
    else await page.setViewport({ width: 1280, height: 800 });

    sessions.set(id, {
      browser, page, mode,
      status: "RUNNING",
      context: context || null,
      createdAt: new Date(),
      resolvedAt: null,
      trace: [],
      cdp: null,
      watchers: null,
      screencastActive: false,
      rescueToken: null, // set when /rescue is called, required for /act and /resume during PAUSED
    });

    console.log(`[${id}] Session created (${mode}, page: ${page.url()})`);
    res.json({ session_id: id, status: "RUNNING", mode });
  } catch (e) {
    res.status(500).json({ error: "Failed to create session", detail: e.message });
  }
});

app.get("/sessions/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });

  let browserAlive = true;
  try { if (!s.page || !s.browser.connected) browserAlive = false; }
  catch { browserAlive = false; }

  res.json({
    session_id: req.params.id,
    status: browserAlive ? s.status : "DEAD",
    context: s.context,
    trace_count: s.trace.length,
    created_at: s.createdAt,
    resolved_at: s.resolvedAt,
    browser_alive: browserAlive,
  });
});

app.get("/sessions/:id/screenshot", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  try {
    const screenshot = await s.page.screenshot({ encoding: "base64", type: "jpeg", quality: 70 });
    res.json({ screenshot });
  } catch (e) {
    res.status(500).json({ error: "Screenshot failed", detail: e.message });
  }
});

// Auth helper: during PAUSED state, require rescue token
function checkRescueAuth(req, res, s) {
  if (s.status === "PAUSED_NEEDS_HUMAN" && s.rescueToken) {
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    if (bearer !== s.rescueToken) {
      res.status(403).json({ error: "Rescue token required" });
      return false;
    }
  }
  return true;
}

app.post("/sessions/:id/act", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  if (!checkRescueAuth(req, res, s)) return;

  const { action, selector, text, url, x, y, toX, toY, steps, key, deltaX, deltaY } = req.body;
  try {
    const page = s.page;
    if (action === "navigate") await page.goto(url, { waitUntil: "load", timeout: 60000 });
    else if (action === "click") await page.click(selector);
    else if (action === "type") await page.type(selector, text);
    else if (action === "click_coords") await page.mouse.click(x, y);
    else if (action === "type_focused") await page.keyboard.type(text);
    else if (action === "key") await page.keyboard.press(key);
    else if (action === "scroll") {
      // Mouse wheel via CDP — the only way to dispatch wheel events
      // Reuse screencast CDP session if active, otherwise create temporary one
      let cdp = s.cdp;
      let tempCdp = false;
      if (!cdp) { cdp = await page.createCDPSession(); tempCdp = true; }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: x || 640,
        y: y || 400,
        deltaX: deltaX || 0,
        deltaY: deltaY || 0,
      });
      if (tempCdp) await cdp.detach();
    }
    else if (action === "drag") {
      const n = steps || 25;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const ease = 1 - Math.pow(1 - t, 2);
        await page.mouse.move(x + (toX - x) * ease, y + (toY - y) * ease);
        await new Promise(r => setTimeout(r, 5 + Math.random() * 15));
      }
      await page.mouse.up();
    }
    else if (action === "screenshot") { /* just take screenshot */ }
    else throw new Error(`Unknown action: ${action}`);

    const screenshot = await page.screenshot({ encoding: "base64", type: "jpeg", quality: 70 });
    s.trace.push({ action, timestamp: new Date().toISOString() });
    res.json({ success: true, screenshot });
  } catch (e) {
    res.status(500).json({ error: "Action failed", detail: e.message });
  }
});

app.post("/sessions/:id/rescue", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });

  const { context } = req.body || {};
  if (context) s.context = context;
  s.status = "PAUSED_NEEDS_HUMAN";
  s.resolvedAt = null;

  await startScreencast(s);

  const token = generateToken(req.params.id);
  s.rescueToken = token; // gates /act and /resume during PAUSED state
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  const pilot_url = `${base}/pilot/${token}`;

  console.log(`[${req.params.id}] Rescue: "${s.context || "needs help"}"`);
  res.json({ pilot_url, expires_in: 600, streaming: s.screencastActive });
});

app.post("/sessions/:id/resume", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  if (!checkRescueAuth(req, res, s)) return;
  s.status = "RUNNING";
  s.resolvedAt = new Date();
  s.rescueToken = null; // clear token on resume
  await stopScreencast(s);
  const elapsed = s.resolvedAt - s.createdAt;
  console.log(`[${req.params.id}] RESUMED (${s.trace.length} actions, ${Math.round(elapsed / 1000)}s)`);
  res.json({ status: "RUNNING" });
});

app.delete("/sessions/:id", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  await stopScreencast(s);
  try {
    if (s.mode === "local") await s.browser.close();
    else s.browser.disconnect();
  } catch {}
  sessions.delete(req.params.id);
  console.log(`[${req.params.id}] Closed`);
  res.json({ status: "CLOSED" });
});

app.get("/sessions", (req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    session_id: id, status: s.status, mode: s.mode, context: s.context,
    created_at: s.createdAt, trace_count: s.trace.length,
  }));
  res.json({ sessions: list });
});

// --- Pilot UI ---

app.get("/pilot/:token", (req, res) => {
  const data = verifyToken(req.params.token);
  if (!data) return res.status(403).send("Invalid or expired rescue link.");

  const { sessionId } = data;
  const s = sessions.get(sessionId);
  const context = s?.context || "";
  const token = req.params.token;
  const wsBase = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/^http/, "ws");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Pilot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }

    .bar { padding: 12px 20px; border-bottom: 1px solid #1a1a1a; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
    .bar-left { display: flex; align-items: center; gap: 12px; }
    .bar-left h1 { font-size: 15px; font-weight: 600; color: #fff; }
    .context { font-size: 13px; color: #f0c040; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #f44; animation: pulse 1.5s infinite; }
    .live-dot.connected { background: #4f4; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .fps { font-size: 11px; color: #555; font-variant-numeric: tabular-nums; }
    .timer { font-size: 12px; color: #666; font-variant-numeric: tabular-nums; }

    .screen-area { flex: 1; display: flex; justify-content: center; align-items: center; background: #000; overflow: hidden; min-height: 0; }
    .screen-container { position: relative; max-width: 100%; max-height: 100%; }
    #screen { display: block; max-width: 90vw; max-height: calc(100vh - 130px); border-radius: 4px; }
    #overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair; }
    #loader { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.85); padding: 6px 16px; border-radius: 16px; font-size: 12px; color: #888; }
    .drag-hint { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.7); color: #f0c040; padding: 4px 10px; border-radius: 10px; font-size: 11px; display: none; }
    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 8px 20px; border-radius: 8px; font-size: 13px; display: none; z-index: 10; transition: opacity 0.3s; }
    .toast.error { background: #d32f2f; color: #fff; }
    .toast.info { background: #333; color: #fff; }

    .controls { padding: 10px 20px; display: flex; gap: 8px; align-items: center; border-top: 1px solid #1a1a1a; flex-shrink: 0; }
    input { padding: 8px 12px; border-radius: 6px; border: 1px solid #2a2a2a; background: #111; color: #fff; font-size: 13px; flex: 1; max-width: 280px; }
    input:focus { outline: none; border-color: #444; }
    button { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.15s; white-space: nowrap; }
    button:active { transform: scale(0.97); }
    .btn-type { background: #222; color: #aaa; }
    .btn-type:hover { background: #333; color: #fff; }
    .btn-done { background: #28a745; color: #fff; margin-left: auto; padding: 8px 24px; }
    .btn-done:hover { background: #2ebd4f; }
    .kb-hint { font-size: 11px; color: #444; }

    .end-screen { display: none; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 12px; }
    .end-screen .icon { font-size: 48px; }
    .end-screen .msg { font-size: 18px; color: #fff; }
    .end-screen .sub { font-size: 13px; color: #666; }
  </style>
</head>
<body>
  <div id="app">
    <div class="bar">
      <div class="bar-left">
        <div class="live-dot" id="liveDot"></div>
        <h1>Pilot</h1>
        ${context ? `<span class="context">${context.replace(/</g, '&lt;')}</span>` : ''}
      </div>
      <div style="display:flex;gap:12px;align-items:center">
        <span class="fps" id="fps"></span>
        <span class="timer" id="timer">0:00</span>
      </div>
    </div>

    <div class="screen-area" id="screenArea" tabindex="0">
      <div class="screen-container">
        <img id="screen">
        <canvas id="overlay"></canvas>
        <div id="loader">connecting...</div>
        <div class="drag-hint" id="dragHint">dragging...</div>
      </div>
    </div>

    <div class="controls">
      <input type="text" id="typeInput" placeholder="Type text..." onkeydown="handleInputKey(event)">
      <button class="btn-type" onclick="sendType()">Send</button>
      <span class="kb-hint">Tab/Enter/Esc forwarded when screen focused</span>
      <button class="btn-done" onclick="done()">Done</button>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <div class="end-screen" id="endScreen">
    <div class="icon" id="endIcon"></div>
    <div class="msg" id="endMsg"></div>
    <div class="sub" id="endSub"></div>
  </div>

  <script>
    const API = '/sessions/${sessionId}';
    const WS_URL = '${wsBase}/ws?session=${sessionId}&token=${token}';
    const TOKEN = '${token}';
    const startTime = Date.now();
    let busy = false;
    let ended = false;

    const img = document.getElementById('screen');
    const overlay = document.getElementById('overlay');
    const ctx = overlay.getContext('2d');
    const screenArea = document.getElementById('screenArea');

    // --- Timer ---
    setInterval(() => {
      if (ended) return;
      const s = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById('timer').textContent = Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
    }, 1000);

    // --- Toast ---
    let toastTimer;
    function showToast(msg, type, duration) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast ' + (type || 'error');
      el.style.display = 'block';
      el.style.opacity = '1';
      clearTimeout(toastTimer);
      if (duration) toastTimer = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.style.display = 'none', 300);
      }, duration);
    }

    // --- End screen ---
    function showEnd(icon, msg, sub) {
      ended = true;
      document.getElementById('app').style.display = 'none';
      document.getElementById('toast').style.display = 'none';
      const el = document.getElementById('endScreen');
      el.style.display = 'flex';
      document.getElementById('endIcon').textContent = icon;
      document.getElementById('endMsg').textContent = msg;
      document.getElementById('endSub').textContent = sub;
    }

    // --- FPS ---
    let frameCount = 0;
    let lastFpsUpdate = Date.now();
    function updateFps() {
      frameCount++;
      const now = Date.now();
      if (now - lastFpsUpdate >= 1000) {
        document.getElementById('fps').textContent = frameCount + ' fps';
        frameCount = 0;
        lastFpsUpdate = now;
      }
    }

    // --- Heartbeat ---
    let heartbeatFails = 0;
    async function heartbeat() {
      if (ended) return;
      try {
        const res = await fetch(API);
        if (res.status === 404) { showEnd('\\u2715', 'Rescue cancelled', 'Session closed.'); return; }
        const data = await res.json();
        if (data.status === 'DEAD') { showEnd('\\u26A0', 'Agent disconnected', 'Browser is no longer available.'); return; }
        if (data.status === 'RUNNING') { showEnd('\\u2713', 'Solved', 'Agent has already continued.'); return; }
        heartbeatFails = 0;
      } catch {
        heartbeatFails++;
        if (heartbeatFails >= 5) showEnd('\\u26A0', 'Connection lost', 'Cannot reach Pilot server.');
      }
    }
    setInterval(heartbeat, 3000);

    // --- Streaming with fallback ---
    let wsAttempts = 0;
    let usePolling = false;
    let pollInterval;
    let ws;

    function connectStream() {
      if (ended || usePolling) return;
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        wsAttempts = 0;
        document.getElementById('liveDot').classList.add('connected');
        document.getElementById('loader').style.display = 'none';
      };

      ws.onmessage = (e) => {
        if (e.data === '__DEAD__') {
          showEnd('\\u26A0', 'Agent disconnected', 'Browser is no longer available.');
          return;
        }
        img.src = 'data:image/jpeg;base64,' + e.data;
        updateFps();
      };

      ws.onclose = () => {
        if (ended) return;
        document.getElementById('liveDot').classList.remove('connected');
        wsAttempts++;
        if (wsAttempts >= 3) {
          usePolling = true;
          startPolling();
        } else {
          setTimeout(connectStream, 1000);
        }
      };

      ws.onerror = () => ws.close();
    }

    function startPolling() {
      document.getElementById('loader').style.display = 'none';
      document.getElementById('fps').textContent = 'polling';
      document.getElementById('liveDot').classList.add('connected');
      pollInterval = setInterval(async () => {
        if (busy || ended) return;
        try {
          const res = await fetch(API + '/screenshot');
          if (!res.ok) return;
          const data = await res.json();
          if (data.screenshot) img.src = 'data:image/jpeg;base64,' + data.screenshot;
        } catch {}
      }, 150);
    }

    connectStream();

    // --- Coordinate mapping ---
    function toPage(e) {
      const rect = overlay.getBoundingClientRect();
      const scaleX = img.naturalWidth / rect.width;
      const scaleY = img.naturalHeight / rect.height;
      return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
      };
    }

    function syncOverlay() {
      overlay.width = img.clientWidth;
      overlay.height = img.clientHeight;
      overlay.style.width = img.clientWidth + 'px';
      overlay.style.height = img.clientHeight + 'px';
    }
    img.onload = syncOverlay;
    window.addEventListener('resize', syncOverlay);

    // --- Keyboard forwarding ---
    // When the screen area is focused, forward special keys to the browser
    const FORWARD_KEYS = new Set([
      'Tab', 'Enter', 'Escape', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown', 'Space',
    ]);

    screenArea.addEventListener('keydown', (e) => {
      if (ended) return;
      // Don't capture if typing in the text input
      if (e.target.tagName === 'INPUT') return;

      if (FORWARD_KEYS.has(e.key)) {
        e.preventDefault();
        postAction({ action: 'key', key: e.key });
        showToast(e.key, 'info', 800);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        // Single printable character — type it
        e.preventDefault();
        postAction({ action: 'type_focused', text: e.key });
      }
    });

    // Auto-focus screen area on click
    overlay.addEventListener('mousedown', () => screenArea.focus());

    // --- Input field key handling ---
    function handleInputKey(e) {
      if (e.key === 'Enter') sendType();
      // Don't forward keys when typing in the input
    }

    // --- Drag detection ---
    let dragStart = null;
    let dragging = false;
    const DRAG_THRESHOLD = 6;

    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault();
      screenArea.focus();
      dragStart = { cx: e.clientX, cy: e.clientY, page: toPage(e) };
      dragging = false;
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!dragStart) return;
      const dx = e.clientX - dragStart.cx;
      const dy = e.clientY - dragStart.cy;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true;
        document.getElementById('dragHint').style.display = 'block';
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        const rect = overlay.getBoundingClientRect();
        const sx = dragStart.cx - rect.left, sy = dragStart.cy - rect.top;
        const ex = e.clientX - rect.left, ey = e.clientY - rect.top;
        ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI*2); ctx.fillStyle='rgba(90,200,250,0.5)'; ctx.fill();
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.strokeStyle='rgba(90,200,250,0.6)'; ctx.lineWidth=2; ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI*2); ctx.fillStyle='rgba(250,200,90,0.5)'; ctx.fill();
      }
    });

    overlay.addEventListener('mouseup', (e) => {
      if (!dragStart) return;
      const end = toPage(e);
      if (dragging) {
        document.getElementById('dragHint').style.display = 'none';
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        postAction({ action: 'drag', x: dragStart.page.x, y: dragStart.page.y, toX: end.x, toY: end.y });
      } else {
        postAction({ action: 'click_coords', x: dragStart.page.x, y: dragStart.page.y });
      }
      dragStart = null;
      dragging = false;
    });

    overlay.addEventListener('mouseleave', () => { if (dragStart && !dragging) dragStart = null; });

    // --- Mouse wheel ---
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (busy || ended) return;
      const coords = toPage(e);
      postAction({ action: 'scroll', x: coords.x, y: coords.y, deltaX: e.deltaX, deltaY: e.deltaY });
    }, { passive: false });

    // --- Actions ---
    async function postAction(body) {
      if (busy || ended) return;
      busy = true;
      try {
        const res = await fetch(API + '/act', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.detail || err.error || 'Action failed', 'error', 3000);
        }
      } catch (e) {
        showToast('Network error', 'error', 3000);
      }
      busy = false;
    }

    function sendType() {
      const text = document.getElementById('typeInput').value;
      if (!text) return;
      postAction({ action: 'type_focused', text });
      document.getElementById('typeInput').value = '';
    }

    async function done() {
      if (ended) return;
      if (ws) ws.close();
      if (pollInterval) clearInterval(pollInterval);
      await fetch(API + '/resume', { method: 'POST', headers: { 'Authorization': 'Bearer ' + TOKEN } });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      showEnd('\\u2713', 'Solved', elapsed + 's \\u2014 agent is continuing');
    }
  </script>
</body>
</html>`);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", sessions: sessions.size, uptime: process.uptime() });
});

server.listen(PORT, () => {
  console.log(`\n  Pilot v0.6 running on http://localhost:${PORT}`);
  console.log(`  + mouse wheel + token-gated actions\n`);
});
