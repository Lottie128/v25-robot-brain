#!/usr/bin/env python3
import io
import json
import os
import queue
import threading
import time
import wave
from dataclasses import dataclass
from math import cos, sin, pi

import requests
import numpy as np
import sounddevice as sd
from PIL import Image, ImageTk
import tkinter as tk

MAC_SERVER_URL = os.environ.get("MAC_SERVER_URL", "http://192.168.1.34:3000")
CAMERA_STREAM_URL = os.environ.get("CAMERA_STREAM_URL", "http://127.0.0.1:8080/stream.mjpg")
LIDAR_STREAM_URL = os.environ.get("LIDAR_STREAM_URL", "http://127.0.0.1:8090/scan")
GPIO_AGENT_URL = os.environ.get("GPIO_AGENT_URL", "http://127.0.0.1:8070")
UI_MODE = os.environ.get("UI_MODE", "full")  # full or face

SAMPLE_RATE = 16000
CHANNELS = 1

@dataclass
class EmotionStyle:
    dx: int = 0
    dy: int = 0
    scale: float = 1.0

EMOTION_MAP = {
    "neutral": EmotionStyle(0, 0, 1.0),
    "happy": EmotionStyle(0, -3, 1.05),
    "excited": EmotionStyle(0, -6, 1.2),
    "curious": EmotionStyle(6, 0, 0.9),
    "focused": EmotionStyle(0, 0, 0.85),
    "sleepy": EmotionStyle(0, 0, 0.6),
    "alert": EmotionStyle(0, 0, 1.15),
    "surprised": EmotionStyle(0, 0, 1.35),
}

class App:
    def __init__(self, root):
        self.root = root
        self.root.title("V25")
        self.root.configure(bg="#0b0f14")
        self.root.attributes("-fullscreen", True)
        self.root.bind("<Escape>", lambda e: self.root.destroy())

        self.recording = False
        self.audio_q = queue.Queue()
        self.camera_img = None
        self.lidar_points = []

        self._build_ui()
        self._start_camera_thread()
        self._start_lidar_thread()

    def _build_ui(self):
        if UI_MODE == "face":
            self._build_face_only()
        else:
            self._build_full()

    def _build_face_only(self):
        self.face_canvas = tk.Canvas(self.root, bg="#0b0f14", highlightthickness=0)
        self.face_canvas.pack(fill="both", expand=True)
        self._draw_face(self.face_canvas, full=True)

    def _build_full(self):
        self.root.grid_columnconfigure(0, weight=2)
        self.root.grid_columnconfigure(1, weight=3)
        self.root.grid_columnconfigure(2, weight=2)
        self.root.grid_rowconfigure(0, weight=1)

        self.face_canvas = tk.Canvas(self.root, bg="#0f1620", highlightthickness=0)
        self.face_canvas.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        self._draw_face(self.face_canvas, full=False)

        self.media_frame = tk.Frame(self.root, bg="#0b0f14")
        self.media_frame.grid(row=0, column=1, sticky="nsew", padx=6, pady=10)
        self.media_frame.grid_rowconfigure(0, weight=1)
        self.media_frame.grid_rowconfigure(1, weight=1)
        self.media_frame.grid_columnconfigure(0, weight=1)

        self.camera_label = tk.Label(self.media_frame, bg="#0b0f14")
        self.camera_label.grid(row=0, column=0, sticky="nsew", pady=(0, 8))

        self.lidar_canvas = tk.Canvas(self.media_frame, bg="#0b0f14", highlightthickness=0)
        self.lidar_canvas.grid(row=1, column=0, sticky="nsew")

        self.controls_frame = tk.Frame(self.root, bg="#0b0f14")
        self.controls_frame.grid(row=0, column=2, sticky="nsew", padx=10, pady=10)

        self._build_controls(self.controls_frame)

    def _build_controls(self, parent):
        status = tk.Label(parent, text="V25 READY", fg="#eaf6ff", bg="#0b0f14", font=("Sora", 14, "bold"))
        status.pack(pady=(0, 10))

        mic_btn = tk.Button(parent, text="Press to Talk", command=self._toggle_recording)
        mic_btn.pack(fill="x", pady=6)

        self.text_out = tk.Text(parent, height=8, bg="#101722", fg="#eaf6ff", wrap="word")
        self.text_out.pack(fill="both", expand=True, pady=6)

        relay_frame = tk.LabelFrame(parent, text="Relays", bg="#0b0f14", fg="#8aa0b6")
        relay_frame.pack(fill="x", pady=6)
        relay_names = ["Water pump", "Fertilizer", "Blue lights", "Bottom lights"]
        for i, name in enumerate(relay_names, start=1):
            btn = tk.Button(relay_frame, text=name, command=lambda rid=i: self._toggle_relay(rid))
            btn.pack(fill="x", pady=2)

        motor_frame = tk.LabelFrame(parent, text="Motion", bg="#0b0f14", fg="#8aa0b6")
        motor_frame.pack(fill="x", pady=6)
        tk.Button(motor_frame, text="Forward", command=lambda: self._motor("forward")).pack(fill="x")
        tk.Button(motor_frame, text="Left", command=lambda: self._motor("left")).pack(fill="x")
        tk.Button(motor_frame, text="Right", command=lambda: self._motor("right")).pack(fill="x")
        tk.Button(motor_frame, text="Back", command=lambda: self._motor("back")).pack(fill="x")
        tk.Button(motor_frame, text="Stop", command=lambda: self._motor("stop")).pack(fill="x")

    def _draw_face(self, canvas, full=False):
        canvas.delete("all")
        w = canvas.winfo_width() or 800
        h = canvas.winfo_height() or 480
        cx = w / 2
        cy = h / 2
        eye_offset = 120 if full else 90
        eye_size = 120 if full else 90

        canvas.create_oval(cx - eye_offset - eye_size/2, cy - eye_size/2,
                           cx - eye_offset + eye_size/2, cy + eye_size/2,
                           outline="#7ef5ea", width=3, fill="#0c4947")
        canvas.create_oval(cx + eye_offset - eye_size/2, cy - eye_size/2,
                           cx + eye_offset + eye_size/2, cy + eye_size/2,
                           outline="#7ef5ea", width=3, fill="#0c4947")

        pupil_size = 30 if full else 24
        self.left_pupil = canvas.create_oval(cx - eye_offset - pupil_size/2, cy - pupil_size/2,
                                             cx - eye_offset + pupil_size/2, cy + pupil_size/2,
                                             fill="#1dd6c3", outline="")
        self.right_pupil = canvas.create_oval(cx + eye_offset - pupil_size/2, cy - pupil_size/2,
                                              cx + eye_offset + pupil_size/2, cy + pupil_size/2,
                                              fill="#1dd6c3", outline="")

    def _set_emotion(self, label):
        style = EMOTION_MAP.get(label, EMOTION_MAP["neutral"])
        for pupil in (self.left_pupil, self.right_pupil):
            x0, y0, x1, y1 = self.face_canvas.coords(pupil)
            cx = (x0 + x1) / 2 + style.dx
            cy = (y0 + y1) / 2 + style.dy
            size = (x1 - x0) * style.scale
            self.face_canvas.coords(pupil, cx - size/2, cy - size/2, cx + size/2, cy + size/2)

    def _toggle_recording(self):
        if not self.recording:
            threading.Thread(target=self._record_and_send, daemon=True).start()
        else:
            self.recording = False

    def _record_and_send(self):
        self.recording = True
        frames = []

        def callback(indata, frames_count, time_info, status):
            if self.recording:
                frames.append(indata.copy())

        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, callback=callback):
            while self.recording:
                time.sleep(0.1)

        audio = np.concatenate(frames, axis=0)
        wav_bytes = io.BytesIO()
        with wave.open(wav_bytes, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes((audio * 32767).astype(np.int16).tobytes())

        transcript = self._post_audio(wav_bytes.getvalue())
        if transcript:
            reply = self._chat(transcript)
            if reply:
                self._tts(reply)
                self._emotion(reply)
                self._append_text(f"You: {transcript}\nV25: {reply}\n")

    def _post_audio(self, wav_data):
        try:
            res = requests.post(f"{MAC_SERVER_URL}/api/transcribe", data=wav_data, headers={"Content-Type": "audio/wav"})
            if res.ok:
                return res.json().get("text", "")
        except Exception:
            pass
        return ""

    def _chat(self, text):
        try:
            res = requests.post(f"{MAC_SERVER_URL}/api/chat", json={"history": [{"role": "user", "content": text}]})
            if res.ok:
                return res.json().get("text", "")
        except Exception:
            pass
        return ""

    def _tts(self, text):
        try:
            res = requests.post(f"{MAC_SERVER_URL}/api/tts", json={"text": text, "format": "wav"})
            if not res.ok:
                return
            with open("/tmp/v25_tts.wav", "wb") as f:
                f.write(res.content)
            os.system("aplay -q /tmp/v25_tts.wav")
        except Exception:
            pass

    def _emotion(self, text):
        try:
            res = requests.post(f"{MAC_SERVER_URL}/api/emotion", json={"text": text})
            if res.ok:
                label = res.json().get("emotion", "neutral")
                self._set_emotion(label)
        except Exception:
            pass

    def _append_text(self, text):
        if hasattr(self, "text_out"):
            self.text_out.insert("end", text)
            self.text_out.see("end")

    def _toggle_relay(self, rid):
        try:
            requests.post(f"{GPIO_AGENT_URL}/relay", json={"id": rid, "state": "on"})
            time.sleep(0.2)
            requests.post(f"{GPIO_AGENT_URL}/relay", json={"id": rid, "state": "off"})
        except Exception:
            pass

    def _motor(self, action):
        try:
            requests.post(f"{GPIO_AGENT_URL}/motor", json={"action": action})
        except Exception:
            pass

    def _start_camera_thread(self):
        def run():
            try:
                stream = requests.get(CAMERA_STREAM_URL, stream=True, timeout=5)
                if not stream.ok:
                    return
                bytes_buf = b""
                for chunk in stream.iter_content(chunk_size=1024):
                    bytes_buf += chunk
                    a = bytes_buf.find(b"\xff\xd8")
                    b = bytes_buf.find(b"\xff\xd9")
                    if a != -1 and b != -1 and b > a:
                        jpg = bytes_buf[a : b + 2]
                        bytes_buf = bytes_buf[b + 2 :]
                        image = Image.open(io.BytesIO(jpg)).resize((420, 240))
                        self.camera_img = ImageTk.PhotoImage(image)
                        if hasattr(self, "camera_label"):
                            self.camera_label.configure(image=self.camera_img)
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()

    def _start_lidar_thread(self):
        def run():
            try:
                res = requests.get(LIDAR_STREAM_URL, stream=True, timeout=5)
                if not res.ok:
                    return
                for line in res.iter_lines():
                    if not line:
                        continue
                    if line.startswith(b"data: "):
                        payload = json.loads(line[6:].decode("utf-8"))
                        self.lidar_points = payload.get("points", [])
                        self._draw_lidar()
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()

    def _draw_lidar(self):
        if not hasattr(self, "lidar_canvas"):
            return
        c = self.lidar_canvas
        c.delete("all")
        w = c.winfo_width() or 420
        h = c.winfo_height() or 180
        radius = h * 0.9
        c.create_arc(w/2 - radius, h - radius, w/2 + radius, h + radius, start=0, extent=180, outline="#1dd6c3")
        for angle, dist in self.lidar_points:
            if dist <= 0:
                continue
            r = min(dist, 2000) / 2000 * radius
            rad = (angle * pi) / 180.0
            x = w/2 + cos(pi - rad) * r
            y = h - sin(pi - rad) * r
            c.create_rectangle(x, y, x+2, y+2, fill="#ff8a3d", outline="")


def main():
    root = tk.Tk()
    app = App(root)
    root.after(200, lambda: app._draw_face(app.face_canvas, full=(UI_MODE == "face")))
    root.mainloop()


if __name__ == "__main__":
    main()
