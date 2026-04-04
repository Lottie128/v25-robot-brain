import http from "node:http";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    process.env[key] = val;
  }
}

loadDotEnv();
console.log("Loaded CONFIG:");
console.log("  CAMERA_STREAM_URL:", process.env.CAMERA_STREAM_URL);
console.log("  LIDAR_STREAM_URL: ", process.env.LIDAR_STREAM_URL);
console.log("  PI_GPIO_AGENT_URL:", process.env.PI_GPIO_AGENT_URL);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_VOICE_ID = process.env.OPENAI_VOICE_ID || "";
const CAMERA_STREAM_URL = process.env.CAMERA_STREAM_URL || "";
const LIDAR_STREAM_URL = process.env.LIDAR_STREAM_URL || "";
const PI_GPIO_AGENT_URL = process.env.PI_GPIO_AGENT_URL || "";

const FAST_MODE = process.env.FAST_MODE ? process.env.FAST_MODE === "1" : true;
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || (FAST_MODE ? 120 : 240));
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || "";
const RELAY_GPIO = (process.env.RELAY_GPIO || "17,27,22,23")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));
const MOTOR_GPIO = (process.env.MOTOR_GPIO || "13,20,19,21")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));

const SYSTEM_INSTRUCTIONS =
  "You are V25, a confident, calm robot brain embedded in a small humanoid. " +
  "Be concise, warm, and practical. Keep responses under 3 short paragraphs or 6 bullets unless asked for more detail.";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

let Gpio = null;
try {
  const mod = await import("onoff");
  Gpio = mod.Gpio;
} catch {}

const relayPins = [];
const motorPins = [];
if (Gpio) {
  for (const pin of RELAY_GPIO.slice(0, 4)) {
    const gpio = new Gpio(pin, "out");
    // Active-low relays: default OFF is HIGH.
    gpio.writeSync(1);
    relayPins.push(gpio);
  }
  for (const pin of MOTOR_GPIO.slice(0, 4)) {
    motorPins.push(new Gpio(pin, "out"));
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function extractOutputText(json) {
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") return part.text;
        }
      }
    }
  }
  return "";
}

async function handleChat(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Missing OPENAI_API_KEY" });
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const history = Array.isArray(payload.history)
    ? payload.history.slice(FAST_MODE ? -6 : -12)
    : [];
  const input = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "")
  }));

  const body = {
    model: OPENAI_MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input,
    temperature: 0.7,
    max_output_tokens: MAX_OUTPUT_TOKENS
  };

  const apiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    sendJson(res, apiRes.status, { error: errText || "OpenAI error" });
    return;
  }

  const json = await apiRes.json();
  const text = extractOutputText(json) || "";
  sendJson(res, 200, { text });
}

async function handleTts(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Missing OPENAI_API_KEY" });
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const text = String(payload.text || "").trim();
  if (!text) {
    sendJson(res, 400, { error: "Missing text" });
    return;
  }

  const reqFormat = String(payload.format || "").toLowerCase();
  const format = ["mp3", "wav", "opus"].includes(reqFormat) ? reqFormat : "mp3";
  const ttsBody = {
    model: OPENAI_TTS_MODEL,
    input: text,
    format,
    voice: OPENAI_VOICE_ID ? { id: OPENAI_VOICE_ID } : "marin"
  };

  const apiRes = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(ttsBody)
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    sendJson(res, apiRes.status, { error: errText || "OpenAI error" });
    return;
  }

  const contentType = format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
  res.writeHead(200, { "Content-Type": contentType });
  const buf = Buffer.from(await apiRes.arrayBuffer());
  res.end(buf);
}

async function handleTranscribe(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Missing OPENAI_API_KEY" });
    return;
  }

  const contentType = req.headers["content-type"] || "audio/webm";
  const audioBuffer = await readBody(req);
  if (!audioBuffer.length) {
    sendJson(res, 400, { error: "Missing audio" });
    return;
  }

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: contentType });
  form.append("file", blob, "audio.webm");
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  if (TRANSCRIBE_LANGUAGE) form.append("language", TRANSCRIBE_LANGUAGE);

  const apiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    sendJson(res, apiRes.status, { error: errText || "OpenAI error" });
    return;
  }

  const json = await apiRes.json();
  sendJson(res, 200, { text: json.text || "" });
}

async function handleEmotion(req, res) {
  if (FAST_MODE) {
    sendJson(res, 200, { emotion: "neutral" });
    return;
  }
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Missing OPENAI_API_KEY" });
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const text = String(payload.text || "").trim();
  if (!text) {
    sendJson(res, 400, { error: "Missing text" });
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    instructions:
      "Classify the emotion of the assistant reply into exactly one of: neutral, happy, excited, curious, focused, sleepy, alert, surprised. " +
      "Respond with only the single word label.",
    input: text,
    temperature: 0.2
  };

  const apiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    sendJson(res, apiRes.status, { error: errText || "OpenAI error" });
    return;
  }

  const json = await apiRes.json();
  const label = (extractOutputText(json) || "neutral").trim().toLowerCase();
  sendJson(res, 200, { emotion: label });
}

async function handleConfig(req, res) {
  sendJson(res, 200, {
    fastMode: FAST_MODE,
    pi: {
      gpioAgentUrl: PI_GPIO_AGENT_URL || "",
      cameraStreamUrl: CAMERA_STREAM_URL || "",
      lidarStreamUrl: LIDAR_STREAM_URL || ""
    }
  });
}

async function handleRelay(req, res) {
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const id = Number(payload.id);
  const state = String(payload.state || "").toLowerCase();
  if (!Number.isFinite(id) || id < 1 || id > 4 || !["on", "off"].includes(state)) {
    sendJson(res, 400, { error: "Invalid relay request" });
    return;
  }

  if (PI_GPIO_AGENT_URL) {
    try {
      const agentRes = await fetch(`${PI_GPIO_AGENT_URL}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, state })
      });
      const text = await agentRes.text();
      if (!agentRes.ok) {
        console.error(`GPIO agent error: ${agentRes.status} ${text}`);
        sendJson(res, agentRes.status, { error: text || "GPIO agent error" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    } catch (err) {
      console.error(`GPIO agent unreachable at ${PI_GPIO_AGENT_URL}:`, err.message);
      sendJson(res, 502, { error: "GPIO agent unreachable" });
      return;
    }
  }

  if (!relayPins.length) {
    sendJson(res, 500, { error: "GPIO not available (install onoff on Pi)" });
    return;
  }

  const pin = relayPins[id - 1];
  // Active-low relays: ON=0, OFF=1
  await pin.write(state === "on" ? 0 : 1);
  sendJson(res, 200, { ok: true });
}

function setMotor(l1, l2, r1, r2) {
  if (!motorPins.length) return;
  motorPins[0].writeSync(l1);
  motorPins[1].writeSync(l2);
  motorPins[2].writeSync(r1);
  motorPins[3].writeSync(r2);
}

async function handleMotor(req, res) {
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const action = String(payload.action || "").toLowerCase();
  if (!["forward", "back", "left", "right", "stop"].includes(action)) {
    sendJson(res, 400, { error: "Invalid motor action" });
    return;
  }

  if (PI_GPIO_AGENT_URL) {
    try {
      const agentRes = await fetch(`${PI_GPIO_AGENT_URL}/motor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const text = await agentRes.text();
      if (!agentRes.ok) {
        console.error(`GPIO agent motor error: ${agentRes.status} ${text}`);
        sendJson(res, agentRes.status, { error: text || "GPIO agent error" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    } catch (err) {
      console.error(`GPIO agent unreachable at ${PI_GPIO_AGENT_URL}:`, err.message);
      sendJson(res, 502, { error: "GPIO agent unreachable" });
      return;
    }
  }

  if (!motorPins.length) {
    sendJson(res, 500, { error: "GPIO not available (install onoff on Pi)" });
    return;
  }

  if (action === "forward") setMotor(1, 0, 1, 0);
  if (action === "back") setMotor(0, 1, 0, 1);
  if (action === "left") setMotor(0, 1, 1, 0);
  if (action === "right") setMotor(1, 0, 0, 1);
  if (action === "stop") setMotor(0, 0, 0, 0);

  sendJson(res, 200, { ok: true });
}

async function handleCameraProxy(req, res) {
  if (!CAMERA_STREAM_URL) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Camera not configured");
    return;
  }
  try {
    const camUrl = new URL(CAMERA_STREAM_URL);
    const options = {
      hostname: camUrl.hostname,
      port: camUrl.port,
      path: camUrl.pathname,
      method: "GET",
      timeout: 5000
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(`Camera proxy error at ${CAMERA_STREAM_URL}:`, err.message);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Camera unavailable");
    });

    proxyReq.end();
  } catch (err) {
    console.error(`Camera proxy setup error at ${CAMERA_STREAM_URL}:`, err.message);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Camera unavailable");
  }
}

async function handleLidarProxy(req, res) {
  if (!LIDAR_STREAM_URL) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Lidar not configured");
    return;
  }
  try {
    const lidarUrl = new URL(LIDAR_STREAM_URL);
    const options = {
      hostname: lidarUrl.hostname,
      port: lidarUrl.port,
      path: lidarUrl.pathname,
      method: "GET",
      timeout: 5000
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(`Lidar proxy error at ${LIDAR_STREAM_URL}:`, err.message);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Lidar unavailable");
    });

    proxyReq.end();
  } catch (err) {
    console.error(`Lidar proxy setup error at ${LIDAR_STREAM_URL}:`, err.message);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Lidar unavailable");
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^\.+/, "");

  const fullPath = path.join(PUBLIC_DIR, filePath);
  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url, `http://${host}`);
  console.log(`[${req.method}] ${url.pathname}`);

  if (req.method === "POST" && url.pathname === "/api/chat") {
    await handleChat(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/tts") {
    await handleTts(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/transcribe") {
    await handleTranscribe(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/emotion") {
    await handleEmotion(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    await handleConfig(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/relay") {
    await handleRelay(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/motor") {
    await handleMotor(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/camera") {
    await handleCameraProxy(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lidar") {
    await handleLidarProxy(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`V25 running at http://${HOST}:${PORT}`);
});
