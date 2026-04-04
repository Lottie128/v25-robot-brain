#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Source .env for variables like RPLIDAR_PORT, GPIOs, etc.
if [ -f "pi/.env" ]; then
  export $(grep -v '^#' pi/.env | xargs)
fi

# Use venv python
PYTHON="$ROOT_DIR/.venv/bin/python"

# Start services in background
$PYTHON pi/camera_server.py &
CAM_PID=$!

$PYTHON pi/lidar_server.py &
LIDAR_PID=$!

$PYTHON pi/gpio_agent.py &
GPIO_PID=$!

# Hide mouse cursor
unclutter -idle 0 &
UNCLUTTER_PID=$!

# Start Chromium Face UI in Kiosk Mode
# Note: Use full path for index.html to avoid relativity issues
chromium-browser --kiosk --no-sandbox --incognito \
  --disable-infobars --window-size=800,480 \
  "file://$ROOT_DIR/pi/face-ui/index.html" &
FACE_PID=$!

trap 'kill $CAM_PID $LIDAR_PID $GPIO_PID $FACE_PID $UNCLUTTER_PID 2>/dev/null' INT TERM

wait $CAM_PID $LIDAR_PID $GPIO_PID $FACE_PID $UNCLUTTER_PID
