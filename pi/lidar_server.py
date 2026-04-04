#!/usr/bin/env python3
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from math import floor

from rplidar import RPLidar, RPLidarException

HOST = "0.0.0.0"
PORT = 8090
RPLIDAR_PORT = os.environ.get("RPLIDAR_PORT", "/dev/ttyUSB0")
RPLIDAR_BAUDRATE = int(os.environ.get("RPLIDAR_BAUDRATE", "115200"))

scan_data = [0] * 360
scan_lock = threading.Lock()
scan_event = threading.Event()


def lidar_thread():
    print(f"LiDAR thread started using port {RPLIDAR_PORT}")
    while True:
        lidar = None
        try:
            print("Connecting to LiDAR...")
            lidar = RPLidar(RPLIDAR_PORT, baudrate=RPLIDAR_BAUDRATE, timeout=3)
            
            # Reset and clear buffer
            print("Resetting LiDAR and clearing buffer...")
            lidar.clean_input()
            
            info = lidar.get_info()
            print(f"LiDAR Info: {info}")
            
            health = lidar.get_health()
            print(f"LiDAR Health: {health}")
            
            print("Starting motor...")
            lidar.start_motor()
            time.sleep(1) # Give motor time to spin up
            
            print("Beginning scan loop...")
            for scan in lidar.iter_scans(max_buf_meas=500):
                with scan_lock:
                    for (_, angle, distance) in scan:
                        idx = min(359, floor(angle))
                        scan_data[idx] = distance
                scan_event.set()
        except RPLidarException as e:
            print(f"RPLidarException: {e}")
            time.sleep(2)
        except Exception as e:
            print(f"General LiDAR Error: {e}")
            time.sleep(2)
        finally:
            print("Cleaning up LiDAR connection...")
            try:
                if lidar:
                    lidar.stop()
                    lidar.stop_motor()
                    lidar.disconnect()
            except Exception as e:
                print(f"Cleanup error: {e}")
            print("Retrying in 2 seconds...")
            time.sleep(2)


class LidarHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/scan":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
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
