#!/usr/bin/env python3
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from math import floor

from adafruit_rplidar import RPLidar

HOST = "0.0.0.0"
PORT = 8090
RPLIDAR_PORT = "/dev/ttyUSB0"

scan_data = [0] * 360
scan_lock = threading.Lock()
scan_event = threading.Event()


def lidar_thread():
    lidar = RPLidar(None, RPLIDAR_PORT, timeout=3)
    try:
        for scan in lidar.iter_scans():
            with scan_lock:
                for (_, angle, distance) in scan:
                    idx = min(359, floor(angle))
                    scan_data[idx] = distance
            scan_event.set()
    finally:
        lidar.stop()
        lidar.disconnect()


class LidarHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/scan":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                scan_event.wait(timeout=1.0)
                scan_event.clear()
                with scan_lock:
                    points = []
                    for angle in range(0, 360, 4):
                        dist = scan_data[angle]
                        if dist > 0:
                            points.append([angle, dist])
                payload = json.dumps({"points": points})
                self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.05)
        except Exception:
            pass

    def log_message(self, format, *args):
        return


def main():
    thread = threading.Thread(target=lidar_thread, daemon=True)
    thread.start()
    server = HTTPServer((HOST, PORT), LidarHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
