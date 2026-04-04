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
AUTO_LISTEN = os.environ.get("AUTO_LISTEN", "0") == "1"
WAKE_WORD = os.environ.get("WAKE_WORD", "v25").lower()

SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SECONDS = float(os.environ.get("CHUNK_SECONDS", "2.0"))
SILENCE_RMS = float(os.environ.get("SILENCE_RMS", "0.01"))

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
        self.root.configure(bg="#05070a")
        
        # Initial fullscreen attempt
        self.root.attributes("-fullscreen", True)
        self.root.attributes("-topmost", True)
        self.root.config(cursor="none")
        
        # Robustness: Re-apply fullscreen and focus after window is mapped
        self.root.bind("<Escape>", lambda e: self.root.destroy())
        self.root.bind("<F11>", lambda e: self.root.attributes("-fullscreen", not self.root.attributes("-fullscreen")))
        
        # Force focus and fullscreen after a short delay to ensure WM compliance
        self.root.after(500, self._force_fullscreen)

        self.recording = False
        self.audio_q = queue.Queue()
        self.camera_img = None
        self.lidar_points = []
        
        # State for animations
        self.blink_state = 0.0  # 0.0 = open, 1.0 = closed
        self.look_x = 0.0
        self.look_y = 0.0
        self.current_emotion = "neutral"

        self._build_ui()
        if UI_MODE != "face":
            self._start_camera_thread()
            self._start_lidar_thread()
        if AUTO_LISTEN:
            self._start_auto_listen()
        
        # Start animation loops
        self._animate()
        self._schedule_blink()

    def _force_fullscreen(self):
        """Aggressively force fullscreen and focus"""
        self.root.attributes("-fullscreen", True)
        self.root.attributes("-topmost", True)
        self.root.focus_force()
        # Hide cursor again just in case
        self.root.config(cursor="none")

    def _build_ui(self):
        if UI_MODE == "face":
            self._build_face_only()
        else:
            self._build_full()

    def _build_face_only(self):
        self.face_canvas = tk.Canvas(self.root, bg="#05070a", highlightthickness=0)
        self.face_canvas.pack(fill="both", expand=True)
        # Delay initial draw to ensure window dimensions are ready
        self.root.after(100, lambda: self._draw_face(self.face_canvas, full=True))

    def _build_full(self):
        self.root.grid_columnconfigure(0, weight=2)
        self.root.grid_columnconfigure(1, weight=3)
        self.root.grid_columnconfigure(2, weight=2)
        self.root.grid_rowconfigure(0, weight=1)

        self.face_canvas = tk.Canvas(self.root, bg="#0f1620", highlightthickness=0)
        self.face_canvas.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        self.root.after(100, lambda: self._draw_face(self.face_canvas, full=False))

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

        self.face_canvas = tk.Canvas(self.root, bg="#0f1620", highlightthickness=0)
        self.face_canvas.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        self.root.after(100, lambda: self._draw_face(self.face_canvas, full=False))

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
        w = canvas.winfo_width()
        h = canvas.winfo_height()
        cx, cy = w / 2, h / 2
        
        eye_spacing = 160 if full else 110
        eye_w = 140 if full else 100
        eye_h = 100 if full else 75
        
        # Draw Left & Right Eyes
        self._draw_eye(canvas, cx - eye_spacing, cy, eye_w, eye_h, "left")
        self._draw_eye(canvas, cx + eye_spacing, cy, eye_w, eye_h, "right")

    def _draw_eye(self, canvas, x, y, w, h, side):
        # Socket shadow (outer glow feel)
        canvas.create_oval(x - w/2 - 4, y - h/2 - 4, x + w/2 + 4, y + h/2 + 4, 
                          fill="#0a0e14", outline="#1dd6c3", width=1)
        
        # Eye socket (Off-white)
        canvas.create_oval(x - w/2, y - h/2, x + w/2, y + h/2, 
                          fill="#f0f8ff", outline="#7ef5ea", width=2)
        
        # Iris (Gradients are hard in TK, so we use concentric circles)
        iris_r = h * 0.42
        # Add "saccades" (tiny rapid eye movements)
        saccade_x = np.random.uniform(-0.01, 0.01)
        saccade_y = np.random.uniform(-0.01, 0.01)
        
        iris_x = x + ((self.look_x + saccade_x) * (w/2 - iris_r))
        iris_y = y + ((self.look_y + saccade_y) * (h/2 - iris_r))
        
        # Outer iris
        canvas.create_oval(iris_x - iris_r, iris_y - iris_r, 
                          iris_x + iris_r, iris_y + iris_r, 
                          fill="#1dd6c3", outline="#0c4947", width=1)
        
        # Inner iris detail
        canvas.create_oval(iris_x - iris_r*0.7, iris_y - iris_r*0.7, 
                          iris_x + iris_r*0.7, iris_y + iris_r*0.7, 
                          fill="#16a091", outline="")
        
        # Pupil
        pupil_r = iris_r * 0.45
        canvas.create_oval(iris_x - pupil_r, iris_y - pupil_r, 
                          iris_x + pupil_r, iris_y + pupil_r, 
                          fill="#05070a", outline="")
        
        # Glint (Main reflection)
        glint_r = pupil_r * 0.6
        canvas.create_oval(iris_x - pupil_r*0.7, iris_y - pupil_r*0.8,
                          iris_x - pupil_r*0.7 + glint_r, iris_y - pupil_r*0.8 + glint_r,
                          fill="#ffffff", outline="")
        
        # Secondary Glint (Subtle)
        canvas.create_oval(iris_x + pupil_r*0.3, iris_y + pupil_r*0.4,
                          iris_x + pupil_r*0.3 + glint_r*0.4, iris_y + pupil_r*0.4 + glint_r*0.4,
                          fill="#ffffff", stipple="gray50", outline="")

        # Eyelids (Blink logic)
        lid_color = "#05070a" if UI_MODE == "face" else "#0f1620"
        
        # Ease the blink curve (cos-based easing for organic feel)
        eased_blink = (1 - cos(self.blink_state * pi)) / 2 if self.blink_state > 0 else 0
        
        # Top Lid
        top_lid_y = y - h/2 - 10
        top_lid_target = y - h/2 + (h * eased_blink)
        canvas.create_rectangle(x - w/2 - 10, top_lid_y, x + w/2 + 10, top_lid_target, 
                                fill=lid_color, outline="")
        
        # Bottom Lid (slight upward movement during blink)
        bot_lid_y = y + h/2 + 10
        bot_lid_target = y + h/2 - (h * eased_blink * 0.15)
        canvas.create_rectangle(x - w/2 - 10, bot_lid_target, x + w/2 + 10, bot_lid_y, 
                                fill=lid_color, outline="")

    def _animate(self):
        """Update animations every 20ms (50fps)"""
        if hasattr(self, "face_canvas"):
            self._draw_face(self.face_canvas, full=(UI_MODE == "face"))
        self.root.after(20, self._animate)

    def _schedule_blink(self):
        """Randomized blinking with organic timing"""
        def do_blink():
            # Closing (fast)
            steps = 4
            for i in range(steps + 1):
                self.blink_state = i / float(steps)
                time.sleep(0.015)
            # Opening (slightly slower)
            for i in range(steps + 1):
                self.blink_state = 1.0 - (i / float(steps))
                time.sleep(0.02)
            self.blink_state = 0.0
            
        def blink_loop():
            while True:
                # Normal blink interval
                time.sleep(np.random.uniform(3.0, 7.0))
                do_blink()
                # Occasional double-blink
                if np.random.random() < 0.2:
                    time.sleep(0.1)
                    do_blink()
        
        threading.Thread(target=blink_loop, daemon=True).start()

    def _set_emotion(self, label):
        self.current_emotion = label
        style = EMOTION_MAP.get(label, EMOTION_MAP["neutral"])
        # Subtle look shifts based on emotion
        self.look_x = style.dx / 10.0
        self.look_y = style.dy / 10.0

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

    def _start_auto_listen(self):
        def run():
            while True:
                try:
                    audio = sd.rec(int(SAMPLE_RATE * CHUNK_SECONDS), samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="float32")
                    sd.wait()
                    rms = float(np.sqrt(np.mean(np.square(audio))))
                    if rms < SILENCE_RMS:
                        continue
                    wav_bytes = io.BytesIO()
                    with wave.open(wav_bytes, "wb") as wf:
                        wf.setnchannels(CHANNELS)
                        wf.setsampwidth(2)
                        wf.setframerate(SAMPLE_RATE)
                        wf.writeframes((audio * 32767).astype(np.int16).tobytes())
                    transcript = self._post_audio(wav_bytes.getvalue())
                    if not transcript:
                        continue
                    transcript_l = transcript.lower()
                    if WAKE_WORD and WAKE_WORD not in transcript_l:
                        continue
                    cleaned = transcript_l.replace(WAKE_WORD, "").strip()
                    if not cleaned:
                        continue
                    reply = self._chat(cleaned)
                    if reply:
                        self._tts(reply)
                        self._emotion(reply)
                except Exception:
                    time.sleep(0.5)
        threading.Thread(target=run, daemon=True).start()

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
