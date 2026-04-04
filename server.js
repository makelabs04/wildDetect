// server.js  — Animal & Bird Detector (Node backend)
// AI detection runs in the browser (COCO-SSD via CDN)
// Node handles: HTTP server, voice alerts (say), alert log, cooldowns
// ESP32 LED API: GET /api/led  →  {"ok":true,"data":{"led_code":"R","label":"bird","buzz":1}}

const express   = require("express");
const http      = require("http");
const { WebSocketServer } = require("ws");
const say       = require("say");
const path      = require("path");

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
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  ESP32 LED STATE
//  The ESP32 polls GET /api/led every second.
//  led_code: "G" = green solid (clear), "R" = red blink (animal/bird detected)
// ══════════════════════════════════════════════════════════════════════════
let espState = {
  led_code:  "G",    // "G" = green solid, "R" = red blink
  label:     "",     // what was detected
  buzz:      0,      // number of buzzer beeps
};

// How long to hold "R" before auto-resetting to "G" (ms)
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

// ── ESP32 Poll Endpoint: GET /api/led ─────────────────────────────────────
app.get("/api/led", (req, res) => {
  res.json({
    ok: true,
    data: {
      led_code: espState.led_code,
      label:    espState.label,
      buzz:     espState.buzz,
    },
  });
  // Clear buzz after delivery so it fires only once per detection
  if (espState.buzz > 0) espState.buzz = 0;
});

// ── WebSocket: receive detections from browser, speak alerts ─────────────
wss.on("connection", (ws) => {
  console.log("🌐 Browser connected");
  ws.send(JSON.stringify({ type: "connected", msg: "Node server ready" }));

  // Server-side ping every 25s to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 25000);

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Handle client keepalive ping → reply with pong
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (data.type === "detections") {
      for (const det of data.detections) {
        const label = det.label.toLowerCase();
        if (!ALERT_MESSAGES[label]) continue;
        if (!canAlert(label)) continue;

        // Dangerous animals get 2 beeps, others get 1
        const isDangerous = label === "elephant" || label === "bear";
        const buzzCount   = isDangerous ? 2 : 1;

        // Trigger ESP32 red LED
        setLedRed(label, buzzCount);
        console.log(`[ESP32] LED → RED  label="${label}"  buzz=${buzzCount}`);

        // Build spoken message
        let msg = ALERT_MESSAGES[label];
        if (det.distance === "very close") {
          msg = `Warning! ${label} is very close ${det.position}! ` + msg;
        } else if (det.distance === "close") {
          msg += ` It is close on your ${det.position}.`;
        }

        console.log(`🔊 VOICE: ${msg}`);
        say.speak(msg, null, 1.0, (err) => {
          if (err) console.error("TTS error:", err.message);
        });

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

  ws.on("error", () => clearInterval(pingInterval));
});

// ── Serve the single-page frontend ────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, () => {
  console.log(`\n✅ WildDetect — Animal & Bird Detector`);
  console.log(`🌐 Browser UI:  http://localhost:${PORT}`);
  console.log(`📡 ESP32 Poll:  http://<your-server-ip>:${PORT}/api/led\n`);
});
