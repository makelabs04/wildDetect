// server.js  — Animal & Bird Detector (Node backend)
// AI detection runs in the browser (COCO-SSD via CDN)
// Node handles: HTTP server, voice alerts (say), alert log, cooldowns

const express   = require("express");
const http      = require("http");
const { WebSocketServer } = require("ws");
const say       = require("say");
const path      = require("path");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT = 3000;

// ── Alert messages (same as your original alerts.js) ──
const ALERT_MESSAGES = {
  bird:     "Bird detected nearby!",
  elephant: "Danger! Elephant detected! Stay away!",
  cow:      "Alert! Cow detected nearby!",
  sheep:    "Notice! Sheep or goat detected nearby!",
  horse:    "Horse detected nearby!",
  dog:      "Dog detected nearby!",
  // COCO-SSD maps lion, tiger, leopard → "cat". We use a broader message.
  cat:      "Feline animal detected! Could be a cat, lion, or tiger. Check carefully!",
  bear:     "Danger! Bear detected! Move away!",
  zebra:    "Zebra spotted nearby!",
  giraffe:  "Giraffe spotted nearby!",
};

// ── Cooldowns: prevent repeated alerts ──
const cooldowns   = {};
let   cooldownMs  = 8000; // default 8 s, client can change this

function canAlert(label) {
  const now = Date.now();
  if (cooldowns[label] && now - cooldowns[label] < cooldownMs) return false;
  cooldowns[label] = now;
  return true;
}

// ── Broadcast to all connected browser clients ──
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── WebSocket: receive detections from browser, speak alerts ──
wss.on("connection", (ws) => {
  console.log("🌐 Browser connected");
  ws.send(JSON.stringify({ type: "connected", msg: "Node server ready" }));

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "detections") {
      // data.detections = [{ label, confidence, distance, position }, ...]
      for (const det of data.detections) {
        const label = det.label.toLowerCase();
        if (!ALERT_MESSAGES[label]) continue;
        if (!canAlert(label)) continue;

        // Build spoken message with distance + direction
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

        // Echo alert back to browser for the log UI
        broadcast({ type: "alert", label, msg, distance: det.distance });
      }
    }

    if (data.type === "setCooldown") {
      cooldownMs = data.value * 1000;
      console.log(`⏱ Cooldown set to ${data.value}s`);
    }
  });

  ws.on("close", () => console.log("🔌 Browser disconnected"));
});

// ── Serve the single-page frontend ──
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, () => {
  console.log(`\n✅ Animal & Bird Detector running`);
  console.log(`🌐 Open in browser: http://localhost:${PORT}\n`);
});