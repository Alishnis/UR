"""Mission 1 (Wi-Fi + HTTP GET) of the mock ESP32: a twin of src/mission1.cpp.

The message texts are part of the protocol (docs/PROTOCOL.md, the GUI parses them), so they
must match the firmware word for word. body_lines() is checked against the firmware's
m1text::forEachBodyLine() in tests/test_mission1_twin.py.
"""

from __future__ import annotations

from typing import Callable

SAMPLE_TEXT = "Congratulations!!! This is the WiFi API task message for the fall training."
SAMPLE_NETWORKS = {"UR_Field": "12345678"}  # ssid -> password ("" = open network)
# What the mock radio "hears" besides the known networks: (ssid, rssi, channel, open)
NEIGHBOURS = (("CityU-Guest", -67, 1, True), ("eduroam", -74, 11, False), ("", -88, 6, False))
SCAN_MS = 1500
MAX_SCAN_SHOWN = 15

WIFI_CONNECT_TIMEOUT_MS = 15000
MAX_BODY_BYTES = 2048
MAX_GOT_LINES = 20
MAX_GOT_LINE_LEN = 300
_LINE_BUFFER = 512  # firmware's internal buffer: lines are cut to _LINE_BUFFER - 1


class HttpFailure(Exception):
    """Raise from an http_get callable to produce `N http error: <message>`."""


HttpGet = Callable[[str], "tuple[int, bytes]"]


def default_http_get(url: str) -> tuple[int, bytes]:
    return 200, SAMPLE_TEXT.encode()


def body_lines(body: bytes, max_lines: int, max_len: int) -> tuple[list[str], int]:
    """Mirror of m1text::forEachBodyLine(): returns (lines, dropped)."""
    cap = min(max_len + 1, _LINE_BUFFER)
    out: list[str] = []
    dropped = 0
    for raw in body.split(b"\n"):
        trimmed = raw.strip(b" \t\r")
        if not trimmed:
            continue
        if len(out) < max_lines:
            text = "".join(chr(c) if 0x20 <= c <= 0x7E else "?" for c in trimmed[: cap - 1])
            out.append(text)
        else:
            dropped += 1
    return out, dropped


class MockMission1:
    def __init__(
        self,
        emit: Callable[[str], None],
        stop_thrusters: Callable[[], None],
        after_get: Callable[[], None],
        networks: dict[str, str] | None = None,
        connect_delay_ms: int = 800,
        http_get: HttpGet | None = None,
    ) -> None:
        self._emit = emit
        self._stop_thrusters = stop_thrusters
        self._after_get = after_get
        self.networks = dict(SAMPLE_NETWORKS if networks is None else networks)
        self.connect_delay_ms = connect_delay_ms
        self.http_get: HttpGet = http_get or default_http_get
        self.state = "idle"  # idle | connecting | connected | failed
        self.ssid = ""
        self.password = ""
        self.url = ""
        self._start_ms = 0
        self._reported_no_ssid = False
        self._scan_start: int | None = None

    # -- commands ---------------------------------------------------------
    def connect(self, ssid: str, password: str, now: int) -> None:
        self._stop_thrusters()
        if self._scan_start is not None:
            self._scan_start = None
            self._emit("N scan: cancelled (joining Wi-Fi)")
        self.ssid, self.password = ssid, password
        self._start_ms = now
        self._reported_no_ssid = False
        if 0 < len(password) < 8:  # WiFi.begin() refuses a WPA2 key this short
            self.state = "failed"
            self._emit("N wifi: failed to start joining (a WPA2 password needs 8-63 characters)")
            return
        self.state = "connecting"
        self._emit(f"N wifi: connecting to {ssid}")

    def set_url(self, url: str) -> None:
        self.url = url
        self._emit(f"N url set: {url}")

    def scan(self, now: int) -> None:
        if self._scan_start is not None:
            self._emit("N scan: already running")
            return
        if self.state == "connecting":
            self._emit("N scan: busy joining Wi-Fi, scan again when it is connected or failed")
            return
        self._scan_start = now
        self._emit("N scan: started")

    def scan_result(self) -> list[tuple[str, int, int, bool]]:
        """(ssid, rssi, channel, open) strongest first, like the firmware."""
        nets = [(ssid, -48 - 9 * i, 6, pw == "") for i, (ssid, pw) in enumerate(self.networks.items())]
        return sorted(nets + list(NEIGHBOURS), key=lambda n: -n[1])

    def _finish_scan(self) -> None:
        nets = self.scan_result()
        self._emit(f"N scan: {len(nets)} networks")
        for ssid, rssi, ch, is_open in nets[:MAX_SCAN_SHOWN]:
            name = "".join(c if 0x20 <= ord(c) <= 0x7E else "?" for c in ssid[:32]) or "(hidden)"
            self._emit(f"N net: {rssi} dBm ch {ch} {'open' if is_open else 'secured'} {name}")
        if len(nets) > MAX_SCAN_SHOWN:
            self._emit(f"N scan: ({len(nets) - MAX_SCAN_SHOWN} more not shown)")

    def get(self, now: int) -> None:
        self._stop_thrusters()
        if self._scan_start is not None:
            self._scan_start = None
            self._emit("N scan: cancelled (GET)")
        if self.state != "connected":
            self._emit("N http error: wifi not connected (send M first)")
            return  # no blocking call happened: input is not flushed
        if not self.url:
            self._emit("N http error: no URL set (send U first)")
            return
        try:
            self._request()
        finally:
            self._after_get()

    def _request(self) -> None:
        self._emit(f"N get: {self.url}")
        try:
            code, body = self.http_get(self.url)
        except HttpFailure as e:
            self._emit(f"N http error: {e}")
            return
        if code < 200 or code >= 300:
            self._emit(f"N http error {code}")
            return
        kept = body[:MAX_BODY_BYTES]
        # the firmware stops reading past 4x the cap (128-byte reads), so it counts at most ~that much
        cap = 4 * MAX_BODY_BYTES
        seen = len(body) if len(body) <= cap else min(len(body), (cap // 128 + 1) * 128)
        self._emit(f"N http {code}, {seen} bytes")
        lines, dropped = body_lines(kept, MAX_GOT_LINES, MAX_GOT_LINE_LEN)
        for line in lines:
            self._emit(f"N got: {line}")
        if not lines:
            self._emit("N got: (empty body)")
        if dropped:
            self._emit(f"N got: ({dropped} more lines not shown)")
        if len(body) > len(kept):
            self._emit(f"N got: (cut at {MAX_BODY_BYTES} bytes)")

    # -- progress (called from tick) --------------------------------------------
    def poll(self, now: int) -> None:
        if self._scan_start is not None and now - self._scan_start >= SCAN_MS:
            self._scan_start = None
            self._finish_scan()
        if self.state == "connected":
            if self.ssid not in self.networks:  # the tower disappeared
                self._emit("N wifi: connection lost, reconnecting")
                self.state = "connecting"
                self._start_ms = now
                self._reported_no_ssid = False
            return
        if self.state != "connecting":
            return
        elapsed = now - self._start_ms
        known = self.ssid in self.networks
        if known and self.networks[self.ssid] == self.password:
            if elapsed >= self.connect_delay_ms:
                self.state = "connected"
                self._emit("N wifi: connected, ip 192.168.4.2, rssi -48 dBm")
            return
        if known:  # wrong password
            if elapsed >= 1000:
                self._emit("N wifi: failed, wrong password?")
                self.state = "failed"
            return
        if elapsed >= 1000 and not self._reported_no_ssid:
            self._reported_no_ssid = True
            self._emit(f'N wifi: SSID "{self.ssid}" not found (still trying; 2.4 GHz only, check spelling)')
        if elapsed > WIFI_CONNECT_TIMEOUT_MS:
            self._emit(
                f"N wifi: timeout after {WIFI_CONNECT_TIMEOUT_MS // 1000} s (SSID not found): "
                "check SSID, password, 2.4 GHz network"
            )
            self.state = "failed"
