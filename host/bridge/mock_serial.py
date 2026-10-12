"""Stands in for the ESP32 running the Phase 1 firmware (docs/PROTOCOL.md), so the GUI can be tested without
hardware. Same interface as pyserial.Serial for what the bridge uses: readline(), write(), is_open, close()."""
import threading
import time

NEUTRAL_US = 1500
MAX_DELTA_US = 150  # firmware hard limit (same as the single-ESC test sketch)
WATCHDOG_S = 0.5
TELEMETRY_S = 0.2
MISSION1_TEXT = "Congratulations!!! This is the WiFi API task message for the fall training."


class MockSerial:
    def __init__(self, baud: int = 115200):
        self.baud = baud
        self.is_open = True
        self._incoming = bytearray()
        self._lock = threading.Lock()
        self._running = True
        self.us = [NEUTRAL_US] * 3  # left, right, vertical
        self._last_cmd = time.monotonic()
        self._watchdog_tripped = True  # starts neutral, like after boot
        self._ssid = None
        self._ip = None
        self._url = None
        self._enqueue("N mock esp32 ready (no hardware) - thrusters neutral")
        threading.Thread(target=self._tick_loop, daemon=True).start()

    # ---------- internal ----------
    def _enqueue(self, line: str) -> None:
        with self._lock:
            self._incoming.extend((line.rstrip("\n") + "\n").encode())

    def _tick_loop(self) -> None:
        while self._running:
            time.sleep(TELEMETRY_S)
            if not self._watchdog_tripped and time.monotonic() - self._last_cmd > WATCHDOG_S:
                self.us = [NEUTRAL_US] * 3
                self._watchdog_tripped = True
                self._enqueue("W watchdog: no command for 500 ms, thrusters neutral")
            self._enqueue("T " + " ".join(str(u) for u in self.us))

    def _set(self, values) -> None:
        self.us = [int(round(min(max(NEUTRAL_US + v * 500, NEUTRAL_US - MAX_DELTA_US), NEUTRAL_US + MAX_DELTA_US)))
                   for v in values]

    # ---------- pyserial-compatible ----------
    def readline(self) -> bytes:
        deadline = time.time() + 1.0
        while time.time() < deadline:
            with self._lock:
                idx = self._incoming.find(b"\n")
                if idx >= 0:
                    line = bytes(self._incoming[:idx + 1])
                    del self._incoming[:idx + 1]
                    return line
            time.sleep(0.01)
        return b""

    def write(self, data: bytes) -> int:
        for text in data.decode(errors="replace").splitlines():
            self._handle(text.strip())
        return len(data)

    def _handle(self, text: str) -> None:
        if not text:
            return
        op, _, rest = text.partition(" ")
        if op == "D":
            try:
                values = [float(x) for x in rest.split()]
            except ValueError:
                return  # malformed: ignored, never half-applied
            if len(values) != 3 or any(not -1.0 <= v <= 1.0 for v in values):
                return
            self._set(values)
            self._fed()
        elif op == "S":
            self.us = [NEUTRAL_US] * 3
            self._fed()
        elif op == "P":
            self._fed()
            self._enqueue("PONG")
        elif op == "M":
            self._wifi(rest)
        elif op == "U":
            self._url = rest.strip() or None
            self._enqueue(f"N url set: {self._url}")
        elif op == "G":
            self._http_get()

    def _fed(self) -> None:
        self._last_cmd = time.monotonic()
        self._watchdog_tripped = False

    def _wifi(self, rest: str) -> None:
        ssid = rest.split(maxsplit=1)[0] if rest.strip() else ""

        def run():
            self._enqueue(f'N connecting to "{ssid}"...')
            time.sleep(1.0)
            if not ssid or ssid.lower().startswith("bad"):  # "bad..." tests the failure path
                self._ssid = self._ip = None
                self._enqueue(f'N wifi failed for "{ssid}"')
                return
            self._ssid, self._ip = ssid, f"192.168.4.{sum(map(ord, ssid)) % 200 + 10}"
            self._enqueue(f'N connected to "{ssid}", ip {self._ip}')

        threading.Thread(target=run, daemon=True).start()

    def _http_get(self) -> None:
        if self._ssid is None:
            self._enqueue("N http error: wifi not connected")
        elif self._url is None:
            self._enqueue("N http error: no url (send U <url> first)")
        else:
            self._enqueue(f"N GET {self._url} -> 200")
            self._enqueue(f"N got: {MISSION1_TEXT}")

    def close(self) -> None:
        self._running = False
        self.is_open = False
