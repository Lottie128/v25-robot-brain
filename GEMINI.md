# GEMINI.md - V25 Robot Brain Project Mandates

## Architectural Principles
- **Split-Brain Architecture:** 
  - The MacBook (Mac) is the **AI Brain**. It handles high-level logic, OpenAI API calls, and serves the dashboard.
  - The Raspberry Pi (Pi) is the **Hardware Interface**. It handles GPIO (relays/motors), Camera streaming, LiDAR data, and the Face UI (Tkinter).
- **Communication:** Mac talks to Pi services via HTTP (8070 for GPIO, 8080 for Camera, 8090 for LiDAR). Pi talks to Mac for transcription and TTS.
- **Source of Truth:** The `README.md` is the primary reference for network IPs and GPIO mappings.

## Engineering Standards

### Python (Pi Services)
- **Directory:** All Pi-related code must stay in the `pi/` directory.
- **GPIO:** Use `RPi.GPIO` for hardware control. Remember relays are **Active-Low** (GPIO LOW = ON).
- **Concurrency:** Use `threading` or `asyncio` for non-blocking I/O in servers (Camera/LiDAR).
- **Environment:** Use `.env` files for configuration. Do not hardcode IPs.

### Node.js (Mac Brain)
- **Server:** Express-based `server.js`. Keep logic modular; if it grows, move to a `src/` or `lib/` folder.
- **API Integration:** Use the models specified in `.env` (`gpt-4o-mini` etc.).
- **Dashboard:** Keep `public/` assets clean. Prefer Vanilla JS/CSS for the dashboard as per README.

### Hardware Safety
- **Relay Defaults:** Always ensure relays are initialized to **HIGH** (OFF) at startup to prevent accidental activation.
- **Motor Control:** Implement safety timeouts if no command is received for a duration (e.g., 500ms).

## Development Workflow
- **Validation:** When modifying Pi services, simulate GPIO if hardware is not connected, or provide instructions for manual verification on the Pi.
- **IPs:** Always use the static IP `192.168.1.35` for the Pi and `192.168.1.34` for the Mac in documentation/examples, but pull from `.env` in code.
- **Testing:** New features must include a way to test them without needing the full physical robot assembly where possible (e.g., mock LiDAR data).
