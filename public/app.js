const transcriptEl = document.getElementById("transcript");
const micBtn = document.getElementById("mic");
const sendBtn = document.getElementById("send");
const textInput = document.getElementById("textInput");
const statusPill = document.getElementById("status-pill");
const clockEl = document.getElementById("clock");
const waveEl = document.getElementById("wave");
const wakeToggle = document.getElementById("wakeToggle");
const cameraFeed = document.getElementById("cameraFeed");
const cameraFallback = document.getElementById("cameraFallback");
const lidarCanvas = document.getElementById("lidarCanvas");
const lidarFallback = document.getElementById("lidarFallback");
let fastMode = false;
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get("mode");

if (mode === "face") {
  document.body.classList.add("face-only");
}

async function initCamera() {
  if (!cameraFeed) return;
  cameraFeed.src = "/api/camera";
  cameraFeed.addEventListener("load", () => {
    cameraFeed.style.display = "block";
    if (cameraFallback) cameraFallback.style.display = "none";
  });
  cameraFeed.addEventListener("error", () => {
    cameraFeed.style.display = "none";
    if (cameraFallback) cameraFallback.style.display = "block";
  });
}

function initLidar() {
  if (!lidarCanvas) return;
  const ctx = lidarCanvas.getContext("2d");
  let latestPoints = [];

  const es = new EventSource("/api/lidar");
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      latestPoints = Array.isArray(data.points) ? data.points : [];
      lidarCanvas.style.display = "block";
      if (lidarFallback) lidarFallback.style.display = "none";
    } catch {}
  };
  es.onerror = () => {
    lidarCanvas.style.display = "none";
    if (lidarFallback) lidarFallback.style.display = "block";
  };

  function draw() {
    const w = lidarCanvas.width;
    const h = lidarCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(10, 18, 26, 0.9)";
    ctx.fillRect(0, 0, w, h);
    const radius = h * 0.9;
    ctx.strokeStyle = "rgba(126, 245, 234, 0.12)";
    for (let r = radius / 4; r <= radius; r += radius / 4) {
      ctx.beginPath();
      ctx.arc(w / 2, h, r, Math.PI, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(126, 245, 234, 0.08)";
    for (let a = 0; a <= 180; a += 30) {
      const ang = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(w / 2, h);
      ctx.lineTo(w / 2 + Math.cos(Math.PI - ang) * radius, h - Math.sin(Math.PI - ang) * radius);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(29, 214, 195, 0.8)";
    const maxDist = 2000;
    const clusters = [];
    for (const pt of latestPoints) {
      const angle = (pt[0] * Math.PI) / 180;
      const dist = Math.min(maxDist, pt[1]);
      const r = (dist / maxDist) * radius;
      const x = w / 2 + Math.cos(Math.PI - angle) * r;
      const y = h - Math.sin(Math.PI - angle) * r;
      ctx.fillRect(x, y, 2, 2);

      const near = clusters.find((c) => Math.hypot(c.x - x, c.y - y) < 10);
      if (near) {
        near.x = (near.x * near.count + x) / (near.count + 1);
        near.y = (near.y * near.count + y) / (near.count + 1);
        near.count += 1;
      } else {
        clusters.push({ x, y, count: 1 });
      }
    }

    ctx.strokeStyle = "rgba(255, 138, 61, 0.7)";
    for (const c of clusters) {
      if (c.count < 6) continue;
      const size = Math.min(16, 4 + c.count);
      ctx.beginPath();
      ctx.arc(c.x, c.y, size, 0, Math.PI * 2);
      ctx.stroke();
    }
    requestAnimationFrame(draw);
  }

  draw();
}

let mediaRecorder = null;
let chunks = [];
let isRecording = false;
const history = [];
let micStream = null;
let wakeMode = false;
let awaitingCommand = false;
const WAKE_WORD = "v25";
const CHUNK_MS = 1600;

function addBubble(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  transcriptEl.appendChild(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setStatus(text) {
  statusPill.textContent = text;
}

function pulseWave(active) {
  waveEl.style.opacity = active ? 0.9 : 0.4;
}

async function speak(text) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(await res.text());
  const audioBuf = await res.arrayBuffer();
  const audio = new Audio(URL.createObjectURL(new Blob([audioBuf], { type: "audio/mpeg" })));
  await audio.play();
}

async function sendChat(text) {
  if (!text.trim()) return;
  addBubble("user", text);
  history.push({ role: "user", content: text });
  setStatus("thinking");
  pulseWave(true);

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history })
  });

  if (!res.ok) {
    const err = await res.text();
    addBubble("assistant", `Error: ${err}`);
    setStatus("idle");
    pulseWave(false);
    return;
  }

  const data = await res.json();
  const reply = data.text || "";
  history.push({ role: "assistant", content: reply });
  addBubble("assistant", reply);

  if (!fastMode) {
    try {
      const emoRes = await fetch("/api/emotion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply })
      });
      if (emoRes.ok) {
        const emoData = await emoRes.json();
        const label = (emoData.emotion || "neutral").toLowerCase();
        document.body.className = document.body.className
          .split(" ")
          .filter((c) => !c.startsWith("emotion-"))
          .join(" ");
        document.body.classList.add(`emotion-${label}`);
      }
    } catch {}
  }

  setStatus("speaking");
  try {
    await speak(reply);
  } catch (err) {
    addBubble("assistant", "Audio error: " + err.message);
  }
  setStatus("idle");
  pulseWave(false);
}

async function transcribeAndSend(blob) {
  setStatus("listening");
  pulseWave(true);
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob
  });

  if (!res.ok) {
    const err = await res.text();
    addBubble("assistant", `Transcription error: ${err}`);
    setStatus("idle");
    pulseWave(false);
    return;
  }

  const data = await res.json();
  const text = (data.text || "").trim();
  if (text) {
    await sendChat(text);
  } else {
    addBubble("assistant", "I didn't catch that. Try again?");
    setStatus("idle");
    pulseWave(false);
  }
}

async function ensureStream() {
  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

async function recordChunk(ms = CHUNK_MS) {
  await ensureStream();
  return new Promise((resolve, reject) => {
    const rec = new MediaRecorder(micStream, { mimeType: "audio/webm" });
    const local = [];
    rec.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) local.push(event.data);
    });
    rec.addEventListener("stop", () => {
      resolve(new Blob(local, { type: "audio/webm" }));
    });
    rec.addEventListener("error", (event) => reject(event.error || event));
    rec.start();
    setTimeout(() => rec.stop(), ms);
  });
}

function normalizeWake(text) {
  return text.toLowerCase().replace(/\\s+/g, "");
}

async function wakeLoop() {
  setStatus("wake");
  pulseWave(true);
  while (wakeMode) {
    const blob = await recordChunk();
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob
    });

    if (!res.ok) {
      const err = await res.text();
      addBubble("assistant", `Transcription error: ${err}`);
      setStatus("idle");
      pulseWave(false);
      return;
    }

    const data = await res.json();
    const text = (data.text || "").trim();
    if (!text) continue;

    if (awaitingCommand) {
      awaitingCommand = false;
      await sendChat(text);
      setStatus("wake");
      continue;
    }

    if (normalizeWake(text).includes(WAKE_WORD)) {
      awaitingCommand = true;
      setStatus("awake");
    }
  }
  setStatus("idle");
  pulseWave(false);
}

async function startRecording() {
  await ensureStream();
  mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
  chunks = [];

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  mediaRecorder.addEventListener("stop", async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    await transcribeAndSend(blob);
  });

  mediaRecorder.start();
  isRecording = true;
  setStatus("listening");
  micBtn.classList.add("active");
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;
  mediaRecorder.stop();
  isRecording = false;
  micBtn.classList.remove("active");
}

micBtn.addEventListener("click", async () => {
  if (isRecording) {
    stopRecording();
  } else {
    try {
      await startRecording();
    } catch (err) {
      addBubble("assistant", "Mic error: " + err.message);
      setStatus("idle");
    }
  }
});

sendBtn.addEventListener("click", () => {
  const text = textInput.value;
  textInput.value = "";
  sendChat(text);
});

wakeToggle.addEventListener("click", async () => {
  wakeMode = !wakeMode;
  wakeToggle.classList.toggle("on", wakeMode);
  wakeToggle.textContent = wakeMode ? "Wake: on" : "Wake: off";
  awaitingCommand = false;
  if (wakeMode) {
    try {
      await ensureStream();
      wakeLoop();
    } catch (err) {
      addBubble("assistant", "Mic error: " + err.message);
      wakeMode = false;
      wakeToggle.classList.remove("on");
      wakeToggle.textContent = "Wake: off";
      setStatus("idle");
    }
  } else {
    setStatus("idle");
    pulseWave(false);
  }
});

textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const text = textInput.value;
    textInput.value = "";
    sendChat(text);
  }
});

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  clockEl.textContent = `${hh}:${mm}`;
}

document.querySelectorAll(".toggle[data-relay]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const id = Number(btn.dataset.relay);
    const nextOn = !btn.classList.contains("on");
    try {
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, state: nextOn ? "on" : "off" })
      });
      if (!res.ok) throw new Error(await res.text());
      btn.classList.toggle("on", nextOn);
      btn.textContent = nextOn ? "on" : "off";
    } catch (err) {
      addBubble("assistant", "Relay error: " + err.message);
    }
  });
});

document.querySelectorAll(".motion-btn[data-action]").forEach((btn) => {
  const action = btn.dataset.action;
  const start = async () => {
    if (action === "stop") return;
    await fetch("/api/motor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
  };
  const stop = async () => {
    await fetch("/api/motor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" })
    });
  };

  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
});

updateClock();
setInterval(updateClock, 10000);
setStatus("idle");
initCamera();
initLidar();

if (!document.body.classList.contains("face-only")) {
  addBubble("assistant", "V25 online. Ready for commands.");
}

fetch("/api/config")
  .then((res) => res.json())
  .then((cfg) => {
    fastMode = Boolean(cfg.fastMode);
  })
  .catch(() => {});
