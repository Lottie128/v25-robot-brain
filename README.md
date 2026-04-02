# V25 Robot Brain

Local, lightweight web app for a Raspberry Pi 3B+ with voice input, OpenAI responses, and speech output.

## Setup

1. Copy `.env.example` to `.env` and add your OpenAI key.
2. Run:

```bash
node server.js
```

Then open `http://localhost:3000`.

## Notes

- The UI is full-screen friendly for a 7" display.
- Audio capture uses the browser microphone.
- All AI calls are proxied through the local Node server.
- Wake word mode listens for "V25" and then captures the next phrase.

## Pi Camera (MJPEG)

1. Install Picamera2 (Raspberry Pi OS Bookworm/Bullseye):
   - `sudo apt update`
   - `sudo apt install -y python3-picamera2`
2. Start the MJPEG server:
   - `python3 pi/camera_server.py`
3. Set `CAMERA_STREAM_URL=http://127.0.0.1:8080/stream.mjpg` in `.env` on the Pi.

## RPLidar A1 (SSE)

1. Install the driver:
   - `python3 -m pip install adafruit-circuitpython-rplidar`
2. Start the SSE server:
   - `python3 pi/lidar_server.py`
3. Set `LIDAR_STREAM_URL=http://127.0.0.1:8090/scan` in `.env` on the Pi.

## GPIO (Relays + Motors)

GPIO uses BCM numbering.

Defaults:
- Relays: `17,27,22,23` (physical 11,13,15,16)
- Motor driver L1,L2,R1,R2: `13,20,19,21` (physical 33,38,35,40)

Install GPIO control:
```
npm install onoff
```

Endpoints:
- `POST /api/relay` `{ "id": 1-4, "state": "on"|"off" }`
- `POST /api/motor` `{ "action": "forward"|"back"|"left"|"right"|"stop" }`

## Mac Brain + Pi GPIO Agent (Recommended)

When the server runs on your Mac, GPIO must run on the Pi. Use the agent:

On the Pi:
```
sudo apt install -y python3-rpi.gpio
python3 pi/gpio_agent.py
```

On the Mac `.env`:
```
PI_GPIO_AGENT_URL=http://192.168.1.50:8070
```

The Mac server will forward `/api/relay` and `/api/motor` to the Pi agent.
