# UR ROV — CityUHK Underwater Robotics Fall Training 2026

Laptop (Python + browser GUI) -> USB serial -> ESP32-S3 -> 3 ESCs (left, right, vertical).

| Folder | What |
|---|---|
| `src/main.cpp`, `platformio.ini` | ESP32 firmware: serial protocol, ESC limits, watchdog, Mission 1 Wi-Fi |
| `host/bridge`, `host/webgui` | Browser GUI and its Python bridge: driving, thruster / pin tests, Mission 1 + 2.1 |
| `host/` | Mission 2.1 / 2.2 / 3 / 5 vision tools, simulators, tests — see `host/README.md` |
| `docs/` | `ARCHITECTURE.md` (flow chart), `PROTOCOL.md` (serial commands) |

## Quick start
```bash
pio run -t upload                      # firmware (close the bridge / serial monitor first)
cd host && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
python -m bridge                       # or: python -m bridge --mock   (no hardware)
```
Open http://localhost:8000 -> Connect -> ARM. Motor tests: motor clamped, hand on the power box e-stop.
