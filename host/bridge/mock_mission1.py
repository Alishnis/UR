"""Mission 1 (Wi-Fi + HTTP GET) of the mock ESP32: a twin of src/mission1.cpp.

The message texts are part of the protocol (docs/PROTOCOL.md, the GUI parses them), so they
must match the firmware word for word. body_lines() is checked against the firmware's
m1text::forEachBodyLine() in tests/test_mission1_twin.py.
"""

from __future__ import annotations

from typing import Callable

SAMPLE_TEXT = "Congratulations!!! This is the WiFi API task message for the fall training."
SAMPLE_NETWORKS = {"UR_Field": "12345678"}  # ssid -> password ("" = open network)

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

    # -- commands ---------------------------------------------------------
    def connect(self, ssid: str, password: str, now: int) -> None:
        self._stop_thrusters()
        self.ssid, self.password = ssid, password
        self.state = "connecting"
        self._start_ms = now
        self._reported_no_ssid = False
        self._emit(f"N wifi: connecting to {ssid}")

    def set_url(self, url: str) -> None:
        self.url = url
        self._emit(f"N url set: {url}")

    def get(self, now: int) -> None:
        self._stop_thrusters()
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
        self._emit(f"N http {code}, {len(body)} bytes")
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
