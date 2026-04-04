# V25 Robot Brain

Mac = AI brain + dashboard. Pi = hardware + full-screen eyes + mic capture + speaker output.

This README is the exact state of the system as configured.

---

## Current Architecture (Single Source of Truth)

- **MacBook**
  - Runs `server.js` (OpenAI calls + dashboard)
  - Serves dashboard at `http://localhost:3000` or `http://<MAC_IP>:3000`
  - Shows camera + LiDAR radar + relay/motor controls

- **Raspberry Pi (v25)**
  - Runs hardware services:
    - GPIO agent (relays + motors)
    - Camera MJPEG server
    - LiDAR SSE server
  - Runs **full-screen eyes only** (Tkinter face UI)
  - **Mic is on the Pi**: audio is sent to Mac for transcription + chat
  - **TTS plays on Pi headphone jack**

---

## Network & Static IP (Pi)

**Pi static IP:** `192.168.1.35` on `wlan0`

Configured via NetworkManager (Pi):
- IP: `192.168.1.35/24`
- Gateway: `192.168.1.1`
- DNS: `192.168.1.1, 8.8.8.8`

If you need to re-apply:
```bash
sudo nmcli connection modify preconfigured \
  ipv4.method manual \
  ipv4.addresses 192.168.1.35/24 \
  ipv4.gateway 192.168.1.1 \
  ipv4.dns "192.168.1.1,8.8.8.8" \
  ipv4.ignore-auto-dns yes
sudo nmcli connection down preconfigured
sudo nmcli connection up preconfigured
```

---

## GPIO Pins (Relays + Motors)

**Relays (active‑low)**
- BCM: `22, 23, 24, 25`
- Physical: `15, 16, 18, 22`
- ON = GPIO **LOW**
- OFF = GPIO **HIGH**

**Motor driver (L1, L2, R1, R2)**
- BCM: `13, 20, 19, 21`
- Physical: `33, 38, 35, 40`

**Boot defaults (relays OFF)**
`/boot/firmware/config.txt` contains:
```
gpio=22=op,dh
gpio=23=op,dh
gpio=24=op,dh
gpio=25=op,dh
```
(These make relays OFF at boot. Reboot required.)

---

## Repo Layout

- `server.js` – Mac brain server
- `public/` – Mac dashboard UI
- `pi/` – Pi services
  - `gpio_agent.py`
  - `camera_server.py`
  - `lidar_server.py`
  - `tk_app.py`

---

## Mac Setup (Brain + Dashboard)

### 1) Install Node deps
```bash
# Node >= 18
npm install
```

### 2) Mac `.env`
Create `.env` in repo root:
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe

# Pi endpoints
PI_GPIO_AGENT_URL=http://192.168.1.35:8070
CAMERA_STREAM_URL=http://192.168.1.35:8080/stream.mjpg
LIDAR_STREAM_URL=http://192.168.1.35:8090/scan

# Performance
FAST_MODE=1
MAX_OUTPUT_TOKENS=120
TRANSCRIBE_LANGUAGE=en

# GPIO defaults (BCM)
RELAY_GPIO=22,23,24,25
MOTOR_GPIO=13,20,19,21
```

### 3) Start server (manual)
```bash
node server.js
```
Dashboard:
- `http://localhost:3000`
- `http://<MAC_IP>:3000`

### 4) Auto‑start on boot (LaunchAgent)
Create `~/Library/LaunchAgents/com.v25.robotbrain.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.v25.robotbrain</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/lottie/Code/v25-robot-brain/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/lottie/Code/v25-robot-brain</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/v25-robotbrain.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/v25-robotbrain.err.log</string>
</dict>
</plist>
```
Enable:
```bash
sudo launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.v25.robotbrain.plist
sudo launchctl enable gui/$(id -u)/com.v25.robotbrain
sudo launchctl kickstart -k gui/$(id -u)/com.v25.robotbrain
```

### 5) macOS Local Network Privacy
Allow `node` to access local network:
- System Settings → Privacy & Security → **Local Network** → enable `node`

This is required for the Mac server to reach Pi services.

---

## Pi Setup (Hardware + Face + Mic + Speaker)

### 1) OS deps
```bash
sudo apt update
sudo apt install -y \
  python3-rpi.gpio \
  python3-picamera2 \
  python3-tk python3-pil python3-numpy \
  portaudio19-dev alsa-utils
```

### 2) Python venv
```bash
python3 -m venv --system-site-packages ~/v25-robot-brain/.venv
~/v25-robot-brain/.venv/bin/pip install -r ~/v25-robot-brain/pi/requirements.txt adafruit-circuitpython-rplidar
```

### 3) Pi `.env`
`/home/v25/v25-robot-brain/pi/.env`
```
MAC_SERVER_URL=http://192.168.1.34:3000
CAMERA_STREAM_URL=http://127.0.0.1:8080/stream.mjpg
LIDAR_STREAM_URL=http://127.0.0.1:8090/scan
GPIO_AGENT_URL=http://127.0.0.1:8070

UI_MODE=face
RELAY_GPIO=22,23,24,25
MOTOR_GPIO=13,20,19,21
PYTHONUNBUFFERED=1

RPLIDAR_PORT=/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0
RPLIDAR_BAUDRATE=115200

AUTO_LISTEN=1
WAKE_WORD=V25
CHUNK_SECONDS=2.0
SILENCE_RMS=0.01
```

### 4) Systemd services (auto‑start)
Services created:
- `v25-gpio-agent.service`
- `v25-camera.service`
- `v25-lidar.service`
- `v25-tk.service`

Enable:
```bash
sudo systemctl enable --now v25-gpio-agent v25-camera v25-lidar v25-tk
```

Check:
```bash
systemctl --no-pager --full status v25-gpio-agent v25-camera v25-lidar v25-tk
```

---

## Audio Flow (Pi mic → Mac AI → Pi speaker)

- Pi records audio chunks continuously (`AUTO_LISTEN=1`)
- Wake word: `V25`
- Audio sent to Mac `/api/transcribe`
- Chat sent to Mac `/api/chat`
- TTS requested from Mac `/api/tts` and played on Pi using `aplay` (headphone jack)

Tuning:
- `CHUNK_SECONDS` (default 2.0)
- `SILENCE_RMS` (default 0.01, lower = more sensitive)
- `WAKE_WORD` (set empty to always listen)

---

## Dashboard UI

- Dashboard lives on the Mac (`/public`)
- Camera is flipped 180° in CSS
- Camera/LiDAR panels are responsive height
- LiDAR is rendered as a radar circle (not raw numbers)

Open:
- `http://localhost:3000` (Mac)
- `http://192.168.1.34:3000` (LAN)

Note:
- `http://192.168.1.35:8090/scan` is **raw** data (numbers). Radar UI is on the dashboard.

---

## Troubleshooting

### Relays/Motors fail with `GPIO agent unreachable`
- Ensure Mac and Pi are on same network
- Confirm `node` has Local Network permission on macOS
- Verify Pi services:
  ```bash
  ss -ltnp | grep -E '8070|8080|8090'
  ```

### Camera feed missing in dashboard
- Check Pi camera service:
  ```bash
  systemctl status v25-camera
  ```
- Verify stream:
  ```bash
  curl http://192.168.1.35:8080/stream.mjpg
  ```

### LiDAR idle
- Verify stream:
  ```bash
  curl http://192.168.1.35:8090/scan
  ```
- Check port path:
  `/dev/serial/by-id/...` in Pi `.env`

### Pi reboots when motors run
- Add separate power for motors/relays
- Add flyback diodes/snubber across motors
- Avoid powering motors from Pi 5V rail

---

## Known Good IPs

- Mac: `192.168.1.34`
- Pi: `192.168.1.35`

Update these if your router changes MAC address leases.

