"""Mission 1 on the mock ESP32 (Wi-Fi join + HTTP GET), with a fake clock."""

from __future__ import annotations

import pytest

from bridge.mock_esp32 import MockEsp32
from bridge.mock_mission1 import HttpFailure, SAMPLE_TEXT


class Clock:
    def __init__(self) -> None:
        self.ms = 0

    def __call__(self) -> float:
        return self.ms / 1000


def make(**kw):
    clock = Clock()
    out: list[str] = []
    mock = MockEsp32(emit=out.append, clock=clock, **kw)

    def advance(ms: int, step: int = 10) -> None:
        for _ in range(ms // step):
            clock.ms += step
            mock.tick()

    advance(4000)
    out.clear()
    return mock, out, advance


def send(mock, *lines):
    mock.feed("".join(l + "\n" for l in lines).encode("ascii"))


def n_lines(out):
    return [l for l in out if l.startswith("N ")]


def test_join_success_reports_progress_then_ip():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678")
    assert n_lines(out) == ["N wifi: connecting to UR_Field"]
    advance(1000)
    assert n_lines(out)[-1] == "N wifi: connected, ip 192.168.4.2, rssi -48 dBm"
    assert mock.m1.state == "connected"


def test_password_is_never_echoed():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678")
    advance(1000)
    assert not any("12345678" in l for l in out)


def test_wrong_password():
    mock, out, advance = make()
    send(mock, "M UR_Field wrongpass")
    advance(1500)
    assert n_lines(out)[-1] == "N wifi: failed, wrong password?"
    assert mock.m1.state == "failed"


def test_unknown_ssid_reports_not_found_then_times_out_after_15_s():
    mock, out, advance = make()
    send(mock, "M Nowhere password")
    advance(1500)
    assert n_lines(out)[-1].startswith('N wifi: SSID "Nowhere" not found')
    advance(13000)
    assert mock.m1.state == "connecting"  # not yet 15 s
    advance(1500)
    assert n_lines(out)[-1] == ("N wifi: timeout after 15 s (SSID not found): "
                                "check SSID, password, 2.4 GHz network")
    assert mock.m1.state == "failed"
    assert sum(l.startswith("N wifi: SSID") for l in out) == 1  # reported once


def test_new_m_restarts_the_attempt():
    mock, out, advance = make()
    send(mock, "M Nowhere password")
    advance(2000)
    send(mock, "M UR_Field 12345678")
    advance(1000)
    assert mock.m1.state == "connected"


def test_get_requires_wifi_and_url():
    mock, out, advance = make()
    send(mock, "G")
    assert n_lines(out)[-1] == "N http error: wifi not connected (send M first)"
    send(mock, "M UR_Field 12345678")
    advance(1000)
    send(mock, "G")
    assert n_lines(out)[-1] == "N http error: no URL set (send U first)"


def test_get_prints_the_text_line_by_line():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678", "U http://192.168.4.1/msg")
    advance(1000)
    out.clear()
    send(mock, "G")
    assert n_lines(out) == [
        "N get: http://192.168.4.1/msg",
        f"N http 200, {len(SAMPLE_TEXT)} bytes",
        f"N got: {SAMPLE_TEXT}",
    ]


def test_multiline_empty_and_long_bodies():
    bodies = {
        "http://x/multi": (200, b"first\r\n\r\nsecond\n"),
        "http://x/empty": (200, b""),
        "http://x/many": (200, b"\n".join(f"l{i}".encode() for i in range(25))),
        "http://x/big": (200, b"y" * 3000),
    }
    mock, out, advance = make(http_get=lambda url: bodies[url])
    send(mock, "M UR_Field 12345678")
    advance(1000)

    def get(url):
        out.clear()
        send(mock, f"U {url}", "G")
        return [l for l in n_lines(out) if not l.startswith("N url set")]

    assert get("http://x/multi")[1:] == ["N http 200, 16 bytes", "N got: first", "N got: second"]
    assert get("http://x/empty")[1:] == ["N http 200, 0 bytes", "N got: (empty body)"]
    many = get("http://x/many")
    assert many[-1] == "N got: (5 more lines not shown)"
    assert sum(l.startswith("N got: l") for l in many) == 20
    big = get("http://x/big")
    assert big[1] == "N http 200, 3000 bytes"
    assert big[2] == "N got: " + "y" * 300
    assert big[-1] == "N got: (cut at 2048 bytes)"


def test_http_errors():
    def backend(url):
        if url.endswith("/404"):
            return 404, b"nope"
        if url.endswith("/301"):
            return 301, b""
        raise HttpFailure("connection refused")

    mock, out, advance = make(http_get=backend)
    send(mock, "M UR_Field 12345678")
    advance(1000)
    for url, expect in [("http://x/404", "N http error 404"), ("http://x/301", "N http error 301"),
                        ("http://x/other", "N http error: connection refused")]:
        out.clear()
        send(mock, f"U {url}", "G")
        assert n_lines(out)[-1] == expect


def test_get_stops_thrusters_and_does_not_trip_the_watchdog():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678", "U http://x/")
    advance(1000)
    send(mock, "D 0.2 0.2 0.2")
    assert mock.us == [1600, 1600, 1600]
    send(mock, "G")
    assert mock.us == [1500, 1500, 1500]  # stopped before the blocking call
    out.clear()
    advance(400)  # the GET must not make the watchdog fire
    assert not any(l.startswith("W watchdog") for l in out)


def test_input_queued_during_a_get_is_dropped_as_stale():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678", "U http://x/")
    advance(1000)
    # one burst: GET, then stale drive commands that arrived while it blocked, then a cut line
    mock.feed(b"G\nD 0.3 0.3 0.3\nD 0.3 0.3 0.3\nD 0.3 0")
    assert mock.us == [1500, 1500, 1500]
    mock.feed(b" 0.3\nP\n")  # tail of the cut line is discarded, the next line works
    assert mock.us == [1500, 1500, 1500]
    assert "PONG" in out
    send(mock, "D 0.1 0.1 0.1")
    assert mock.us == [1550, 1550, 1550]


def test_tower_disappearing_is_reported():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678")
    advance(1000)
    del mock.m1.networks["UR_Field"]
    advance(100)
    assert n_lines(out)[-1] == "N wifi: connection lost, reconnecting"


def test_join_and_get_do_not_disturb_telemetry():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678")
    out.clear()
    advance(1000)
    assert sum(l.startswith("T ") for l in out) == 5


def test_a_line_after_a_get_is_not_lost_when_nothing_was_queued():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678", "U http://x/")
    advance(1000)
    send(mock, "G")                      # nothing queued behind it
    out.clear()
    send(mock, "M UR_Field 12345678")    # typed by hand right after: must not vanish
    assert n_lines(out) == ["N wifi: connecting to UR_Field"]


def test_failed_get_precondition_does_not_flush_input():
    mock, out, advance = make()
    mock.feed(b"G\nD 0.1 0.1 0.1\n")  # not connected: instant error, no blocking call
    assert mock.us == [1550, 1550, 1550]


def test_scan_lists_networks_strongest_first():
    mock, out, advance = make()
    send(mock, "L")
    assert n_lines(out) == ["N scan: started"]
    advance(1600)
    lines = n_lines(out)[1:]
    assert lines[0] == "N scan: 4 networks"
    nets = [l for l in lines if l.startswith("N net: ")]
    assert nets[0] == "N net: -48 dBm ch 6 secured UR_Field"
    rssi = [int(l.split()[2]) for l in nets]
    assert rssi == sorted(rssi, reverse=True)
    assert "N net: -88 dBm ch 6 secured (hidden)" in nets
    assert any(" open CityU-Guest" in l for l in nets)


def test_scan_busy_while_joining_and_twice():
    mock, out, advance = make()
    send(mock, "M UR_Field 12345678", "L")
    assert n_lines(out)[-1].startswith("N scan: busy joining Wi-Fi")
    advance(1000)
    send(mock, "L", "L")
    assert n_lines(out)[-2:] == ["N scan: started", "N scan: already running"]


def test_join_or_get_cancels_a_running_scan():
    mock, out, advance = make()
    send(mock, "L", "M UR_Field 12345678")
    assert n_lines(out)[-2:] == ["N scan: cancelled (joining Wi-Fi)", "N wifi: connecting to UR_Field"]
    advance(2000)
    assert not any(l.startswith("N scan: 4") for l in out)  # the cancelled scan never reports
    send(mock, "U http://192.168.4.1/", "L", "G")
    assert "N scan: cancelled (GET)" in out
    assert out[-1] == f"N got: {SAMPLE_TEXT}"


def test_scan_does_not_touch_the_thrusters():
    mock, out, advance = make()
    send(mock, "D 0.1 0.1 0.1", "L")
    assert mock.us == [1550, 1550, 1550]


def test_short_wpa2_password_fails_at_once():
    mock, out, advance = make()
    send(mock, "M UR_Field 1234567")
    assert n_lines(out) == ["N wifi: failed to start joining (a WPA2 password needs 8-63 characters)"]
    assert mock.m1.state == "failed"
