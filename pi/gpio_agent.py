#!/usr/bin/env python3
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = "0.0.0.0"
PORT = int(os.environ.get("GPIO_AGENT_PORT", "8070"))

RELAY_GPIO = [int(x) for x in os.environ.get("RELAY_GPIO", "17,27,22,23").split(",")]
MOTOR_GPIO = [int(x) for x in os.environ.get("MOTOR_GPIO", "13,20,19,21").split(",")]

try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    for pin in RELAY_GPIO[:4] + MOTOR_GPIO[:4]:
        GPIO.setup(pin, GPIO.OUT)
        GPIO.output(pin, GPIO.LOW)
except Exception as e:
    GPIO = None
    GPIO_ERROR = str(e)


def set_motor(l1, l2, r1, r2):
    GPIO.output(MOTOR_GPIO[0], GPIO.HIGH if l1 else GPIO.LOW)
    GPIO.output(MOTOR_GPIO[1], GPIO.HIGH if l2 else GPIO.LOW)
    GPIO.output(MOTOR_GPIO[2], GPIO.HIGH if r1 else GPIO.LOW)
    GPIO.output(MOTOR_GPIO[3], GPIO.HIGH if r2 else GPIO.LOW)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if GPIO is None:
            self._json(500, {"error": f"GPIO unavailable: {GPIO_ERROR}"})
            return

        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            self._json(400, {"error": "Invalid JSON"})
            return

        if self.path == "/relay":
            relay_id = int(data.get("id", 0))
            state = str(data.get("state", "")).lower()
            if relay_id < 1 or relay_id > 4 or state not in ("on", "off"):
                self._json(400, {"error": "Invalid relay request"})
                return
            pin = RELAY_GPIO[relay_id - 1]
            GPIO.output(pin, GPIO.HIGH if state == "on" else GPIO.LOW)
            self._json(200, {"ok": True})
            return

        if self.path == "/motor":
            action = str(data.get("action", "")).lower()
            if action not in ("forward", "back", "left", "right", "stop"):
                self._json(400, {"error": "Invalid motor action"})
                return
            if action == "forward":
                set_motor(1, 0, 1, 0)
            elif action == "back":
                set_motor(0, 1, 0, 1)
            elif action == "left":
                set_motor(0, 1, 1, 0)
            elif action == "right":
                set_motor(1, 0, 0, 1)
            else:
                set_motor(0, 0, 0, 0)
            self._json(200, {"ok": True})
            return

        self._json(404, {"error": "Not found"})

    def log_message(self, format, *args):
        return


def main():
    server = HTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
