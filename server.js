// server.js  — Animal & Bird Detector (Node backend)
// AI detection runs in the browser (COCO-SSD via CDN)
// Node handles: HTTP server, voice alerts (say if available), alert log, cooldowns
// ESP32 LED API: GET /api/led  →  {"ok":true,"data":{"led_code":"R","label":"bird","buzz":1}}

const express   = require("express");
const http      = require("http");
const { WebSocketServer } = require("ws");
const path      = require("path");

// ── TTS: optional — works on desktop Linux/Mac/Windows, skipped on headless server ──
let say = null;
try {
  say = require("say");
  console.log("🔊 TTS (say) loaded — voice alerts enabled");
} catch (e) {
  console.log("⚠️  TTS (say) unavailable — voice alerts disabled, everything else works fine");
}

// ── Global crash guard — stops any unhandled error from killing the server ──
process.on("uncaughtException", (err) => {
  console.error("[WARN] Uncaught exception (server kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[WARN] Unhandled rejection (server kept alive):", reason);
});

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT = 3000;

// ── Alert messages ─────────────────────────────────────────────────────────
const ALERT_MESSAGES = {
  bird:     "Bird detected nearby!",
  elephant: "Danger! Elephant detected! Stay away!",
  cow:      "Alert! Cow detected nearby!",
  sheep:    "Notice! Sheep or goat detected nearby!",
  horse:    "Horse detected nearby!",
  dog:      "Dog detected nearby!",
  cat:      "Feline animal detected! Could be a cat, lion, or tiger. Check carefully!",
  bear:     "Danger! Bear detected! Move away!",
  zebra:    "Zebra spotted nearby!",
  giraffe:  "Giraffe spotted nearby!",
};

// ── Cooldowns: prevent repeated alerts ────────────────────────────────────
const cooldowns  = {};
let   cooldownMs = 8000;

function canAlert(label) {
  const now = Date.now();
  if (cooldowns[label] && now - cooldowns[label] < cooldownMs) return false;
  cooldowns[label] = now;
  return true;
}

// ── Broadcast to all connected browser clients ─────────────────────────────
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── Safe TTS speak — will never crash the server ──────────────────────────
function safeSpeak(msg) {
  if (!say) return;
  try {
    say.speak(msg, null, 1.0, (err) => {
      if (err) console.warn("TTS speak error (non-fatal):", err.message);
    });
  } catch (e) {
    console.warn("TTS call error (non-fatal):", e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  ESP32 LED STATE
//  The ESP32 polls GET /api/led every second.
//  led_code: "G" = green solid (clear), "R" = red blink (animal/bird detected)
// ══════════════════════════════════════════════════════════════════════════
let espState = {
  led_code: "G",
  label:    "",
  buzz:     0,
};

const LED_RED_HOLD_MS = 6000;
let redResetTimer = null;

function setLedRed(label, buzzCount) {
  espState = { led_code: "R", label, buzz: buzzCount };
  if (redResetTimer) clearTimeout(redResetTimer);
  redResetTimer = setTimeout(() => {
    espState = { led_code: "G", label: "", buzz: 0 };
    console.log("[ESP32] LED reset → GREEN (auto)");
  }, LED_RED_HOLD_MS);
}

// ── ESP32 last-seen tracker ───────────────────────────────────────────────
let espLastSeenMs = 0;  // 0 = never connected

// ── ESP32 Poll Endpoint: GET /api/led ─────────────────────────────────────
app.get("/api/led", (req, res) => {
  espLastSeenMs = Date.now();  // ESP32 just checked in
  res.json({
    ok: true,
    data: {
      led_code: espState.led_code,
      label:    espState.label,
      buzz:     espState.buzz,
    },
  });
  if (espState.buzz > 0) espState.buzz = 0;
});

// ── ESP32 Status Endpoint: GET /api/esp-status ───────────────────────────
// ESP32 polls /api/led every 1s — if last seen > 4s ago it is offline
app.get("/api/esp-status", (req, res) => {
  const age    = Date.now() - espLastSeenMs;
  const online = espLastSeenMs > 0 && age < 4000;
  res.json({ online, age_ms: espLastSeenMs > 0 ? age : null });
});

// ── WebSocket: receive detections from browser ────────────────────────────
wss.on("connection", (ws) => {
  console.log("🌐 Browser connected");
  ws.send(JSON.stringify({ type: "connected", msg: "Node server ready" }));

  // Server-side ping every 25s to keep nginx proxy alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 25000);

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Handle client keepalive ping
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (data.type === "detections") {
      for (const det of data.detections) {
        const label = det.label.toLowerCase();
        if (!ALERT_MESSAGES[label]) continue;
        if (!canAlert(label)) continue;

        const isDangerous = label === "elephant" || label === "bear";
        const buzzCount   = isDangerous ? 2 : 1;

        setLedRed(label, buzzCount);
        console.log(`[ESP32] LED → RED  label="${label}"  buzz=${buzzCount}`);

        let msg = ALERT_MESSAGES[label];
        if (det.distance === "very close") {
          msg = `Warning! ${label} is very close ${det.position}! ` + msg;
        } else if (det.distance === "close") {
          msg += ` It is close on your ${det.position}.`;
        }

        console.log(`🔊 VOICE: ${msg}`);
        safeSpeak(msg);  // ← safe wrapper — never crashes server

        broadcast({ type: "alert", label, msg, distance: det.distance });
      }
    }

    if (data.type === "setCooldown") {
      cooldownMs = data.value * 1000;
      console.log(`⏱ Cooldown set to ${data.value}s`);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    console.log("🔌 Browser disconnected");
  });

  ws.on("error", (err) => {
    clearInterval(pingInterval);
    console.warn("WS client error (non-fatal):", err.message);
  });
});

// ── Serve the single-page frontend ────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, () => {
  console.log(`\n✅ WildDetect — Animal & Bird Detector`);
  console.log(`🌐 Browser UI:  http://localhost:${PORT}`);
  console.log(`📡 ESP32 Poll:  http://<your-server-ip>:${PORT}/api/led\n`);
});
