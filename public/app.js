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
let piConfig = { gpioAgentUrl: "", cameraStreamUrl: "", lidarStreamUrl: "" };
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get("mode");

if (mode === "face") {
  document.body.classList.add("face-only");
}

async function initCamera() {
  if (initCamera.started) return;
  initCamera.started = true;
  if (!cameraFeed) return;
  
  // Prefer direct URL if reachable from browser, fallback to proxy
  const proxyUrl = "/api/camera";
  const directUrl = piConfig.cameraStreamUrl;
  
  cameraFeed.src = directUrl || proxyUrl;
  cameraFeed.style.display = "block";
  if (cameraFallback) cameraFallback.style.display = "none";

  cameraFeed.addEventListener("error", () => {
    // If direct failed, try proxy
    if (cameraFeed.src.startsWith("http") && !cameraFeed.src.includes(window.location.host)) {
      console.warn("Direct camera feed failed, falling back to proxy...");
      cameraFeed.src = proxyUrl;
    } else {
      cameraFeed.style.display = "none";
      if (cameraFallback) cameraFallback.style.display = "block";
    }
  });
}

function initLidar() {
  if (initLidar.started) return;
  initLidar.started = true;
  if (!lidarCanvas) return;
  const ctx = lidarCanvas.getContext("2d");
  let latestPoints = [];
  let size = { w: 320, h: 320 };
  lidarCanvas.style.display = "block";
  if (lidarFallback) lidarFallback.style.display = "none";

  function resize() {
    const parent = lidarCanvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const side = Math.min(rect.width, rect.height);
    lidarCanvas.width = Math.round(side * dpr);
    lidarCanvas.height = Math.round(side * dpr);
    lidarCanvas.style.width = `${side}px`;
    lidarCanvas.style.height = `${side}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    size = { w: side, h: side };
  }

  window.addEventListener("resize", resize);
  resize();

  // Prefer direct URL for SSE, fallback to proxy
  const proxyUrl = "/api/lidar";
  const directUrl = piConfig.lidarStreamUrl;
  
  function connectLidar(url) {
    console.log("Connecting to LiDAR SSE:", url);
    const es = new EventSource(url);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.points) {
          latestPoints = data.points;
          if (lidarFallback) lidarFallback.style.display = "none";
        }
      } catch (e) {}
    };
    es.onerror = () => {
      if (url === directUrl && proxyUrl) {
        console.warn("Direct LiDAR SSE failed, falling back to proxy...");
        es.close();
        connectLidar(proxyUrl);
      } else {
        if (lidarFallback) lidarFallback.style.display = "grid";
      }
    };
  }

  connectLidar(directUrl || proxyUrl);

  function draw() {
    const w = size.w;
    const h = size.h;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.45;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(6, 12, 18, 0.92)";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(126, 245, 234, 0.14)";
    for (let r = radius / 4; r <= radius; r += radius / 4) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(126, 245, 234, 0.08)";
    for (let a = 0; a < 360; a += 30) {
      const ang = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * radius, cy + Math.sin(ang) * radius);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(29, 214, 195, 0.9)";
    const maxDist = 4000;
    const clusters = [];
    for (const pt of latestPoints) {
      const angle = ((pt[0] - 90) * Math.PI) / 180;
      const dist = Math.min(maxDist, pt[1]);
      const r = (dist / maxDist) * radius;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      ctx.fillRect(x - 1, y - 1, 2, 2);

      const near = clusters.find((c) => Math.hypot(c.x - x, c.y - y) < 10);
      if (near) {
        near.x = (near.x * near.count + x) / (near.count + 1);
        near.y = (near.y * near.count + y) / (near.count + 1);
        near.count += 1;
      } else {
        clusters.push({ x, y, count: 1 });
      }
    }

    ctx.strokeStyle = "rgba(255, 138, 61, 0.6)";
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
  if (!waveEl) return;
  if (active) {
    waveEl.classList.add("active");
  } else {
    waveEl.classList.remove("active");
  }
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

micBtn?.addEventListener("click", async () => {
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

sendBtn?.addEventListener("click", () => {
  const text = textInput.value;
  textInput.value = "";
  sendChat(text);
});

wakeToggle?.addEventListener("click", async () => {
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

textInput?.addEventListener("keydown", (event) => {
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
    const relayUrl = piConfig.gpioAgentUrl ? `${piConfig.gpioAgentUrl}/relay` : "/api/relay";
    try {
      const res = await fetch(relayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, state: nextOn ? "on" : "off" })
      });
      if (!res.ok) throw new Error(await res.text());
      btn.classList.toggle("on", nextOn);
      btn.textContent = nextOn ? "on" : "off";
      setStatus("online");
    } catch (err) {
      addBubble("assistant", "Relay error: " + err.message);
      setStatus("offline");
    }
  });
});

document.querySelectorAll(".motion-btn[data-action]").forEach((btn) => {
  const action = btn.dataset.action;
  const motorUrl = () => (piConfig.gpioAgentUrl ? `${piConfig.gpioAgentUrl}/motor` : "/api/motor");
  const start = async () => {
    if (action === "stop") return;
    try {
      await fetch(motorUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      setStatus("online");
    } catch (err) {
      addBubble("assistant", "Motor error: " + (err.message || "Failed to fetch"));
      setStatus("offline");
    }
  };
  const stop = async () => {
    try {
      await fetch(motorUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" })
      });
      setStatus("online");
    } catch (err) {
      setStatus("offline");
    }
  };

  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
});

updateClock();
setInterval(updateClock, 10000);
setStatus("idle");

if (!document.body.classList.contains("face-only")) {
  addBubble("assistant", "V25 online. Ready for commands.");
}

async function checkPiDirect() {
  const piIp = "192.168.1.35";
  try {
    const res = await fetch(`http://${piIp}:8070/relay`, { method: "OPTIONS" });
    console.log("Direct Pi access check:", res.ok ? "SUCCESS" : "FAILED (but reachable)");
  } catch (err) {
    console.warn("Direct Pi access check: FAILED (unreachable from browser)", err.message);
  }
}

fetch("/api/config")
  .then((res) => res.json())
  .then((cfg) => {
    fastMode = Boolean(cfg.fastMode);
    if (cfg && cfg.pi) {
      piConfig = {
        gpioAgentUrl: cfg.pi.gpioAgentUrl || "",
        cameraStreamUrl: cfg.pi.cameraStreamUrl || "",
        lidarStreamUrl: cfg.pi.lidarStreamUrl || ""
      };
    }
    initCamera();
    initLidar();
    checkPiDirect();
  })
  .catch(() => {
    initCamera();
    initLidar();
  });
