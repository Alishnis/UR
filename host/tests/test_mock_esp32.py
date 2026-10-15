"""Behaviour of the mock ESP32 (same rules as src/main.cpp), with a fake clock."""

from __future__ import annotations

import pytest

from bridge.mock_esp32 import MockEsp32, EscConfig


class Clock:
    """Fake monotonic clock counting whole milliseconds (no float drift)."""

    def __init__(self) -> None:
        self.ms = 0

    def __call__(self) -> float:
        return self.ms / 1000


@pytest.fixture
def rig():
    clock = Clock()
    out: list[str] = []
    mock = MockEsp32(emit=out.append, clock=clock)

    def advance(ms: int, step: int = 10) -> None:
        for _ in range(ms // step):
            clock.ms += step
            mock.tick()

    def arm() -> None:
        advance(4000)
        assert mock.armed
        out.clear()

    return mock, out, advance, arm


def send(mock: MockEsp32, *lines: str) -> None:
    mock.feed("".join(l + "\n" for l in lines).encode("ascii"))


def test_boot_banner_and_neutral(rig):
    mock, out, advance, _ = rig
    assert any(l.startswith("ROV mode: LIVE") for l in out)
    assert mock.us == [1500, 1500, 1500]
    advance(4000)
    assert "ROV ready, accepting commands" in out


def test_input_dropped_while_arming(rig):
    mock, out, advance, _ = rig
    send(mock, "D 0.2 0.2 0.2")
    advance(4000)
    assert mock.us == [1500, 1500, 1500]


def test_partial_line_across_arming_is_discarded(rig):
    mock, out, advance, _ = rig
    mock.feed(b"D 0.2 0.2")          # starts during arming
    advance(4000)
    mock.feed(b" 0.2\nP\n")         # tail after arming: dropped; next line works
    assert mock.us == [1500, 1500, 1500]
    assert "PONG" in out
    assert not any(l.startswith("W ignored") for l in out)


def test_no_watchdog_warning_at_boot(rig):
    mock, out, advance, arm = rig
    arm()
    advance(2000)
    assert not any(l.startswith("W watchdog") for l in out)


def test_drive_clamp_and_order(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.1 -0.1 0.2")
    assert mock.us == [1550, 1450, 1600]
    send(mock, "D 1 -1 0")
    assert mock.us == [1650, 1350, 1500]


def test_stop_and_ping(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.2 0.2 0.2", "S", "P")
    assert mock.us == [1500, 1500, 1500]
    assert out.count("PONG") == 1


def test_malformed_not_applied_and_warned_once_per_second(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.1 0.1 0.1")
    send(mock, "D 0.9 0.9", "D 0.9 0.9 0.9 0.9", "D 2 0 0", "X")
    assert mock.us == [1550, 1550, 1550]
    warns = [l for l in out if l.startswith("W ignored")]
    assert warns == ['W ignored malformed line: "D 0.9 0.9"']
    advance(1000)
    send(mock, "X")
    assert sum(l.startswith("W ignored") for l in out) == 2


def test_overlong_line_dropped_entirely(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.2 0.2 0.2 " + "0" * 200)
    assert mock.us == [1500, 1500, 1500]
    assert "W ignored overlong line" in out
    send(mock, "D 0.1 0.1 0.1")  # next line is fine again
    assert mock.us == [1550, 1550, 1550]


def test_exactly_max_line_is_accepted(rig):
    mock, out, advance, arm = rig
    arm()
    line = "D 0.1 0.1 0.1" + " " * (160 - 13)
    assert len(line) == 160
    send(mock, line)
    assert mock.us == [1550, 1550, 1550]


def test_non_printable_byte_drops_line(rig):
    mock, out, advance, arm = rig
    arm()
    mock.feed(b"D 0.2 0.2 0.2\x00\n")
    assert mock.us == [1500, 1500, 1500]
    assert "W ignored line with non-printable bytes" in out


def test_crlf_accepted(rig):
    mock, out, advance, arm = rig
    arm()
    mock.feed(b"D 0.1 0.1 0.1\r\n")
    assert mock.us == [1550, 1550, 1550]


def test_watchdog(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.2 0.2 0.2")
    advance(400)
    assert mock.us == [1600, 1600, 1600]
    send(mock, "X", "D 1 1")  # garbage does not refresh the watchdog
    advance(150)
    assert mock.us == [1500, 1500, 1500]
    wd = [l for l in out if l.startswith("W watchdog")]
    assert wd == ["W watchdog: no command for 500 ms, thrusters neutral"]
    advance(2000)
    assert sum(l.startswith("W watchdog") for l in out) == 1  # only once
    send(mock, "D 0.1 0.1 0.1")  # control resumes
    assert mock.us == [1550, 1550, 1550]


def test_ping_refreshes_watchdog(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.2 0.2 0.2")
    for _ in range(5):
        advance(300)
        send(mock, "P")
    assert mock.us == [1600, 1600, 1600]


def test_telemetry_rate(rig):
    mock, out, advance, arm = rig
    arm()
    advance(1000)
    assert sum(l.startswith("T ") for l in out) == 5


def test_readback_once_stream_stop(rig):
    mock, out, advance, arm = rig
    arm()
    send(mock, "D 0.1 -0.1 0.2", "R")
    assert out[-1] == ("R left io1->io4: 1550us 50Hz sent 1550 ok | "
                       "right io42->io5: 1450us 50Hz sent 1450 ok | "
                       "vert io40->io6: 1600us 50Hz sent 1600 ok")
    out.clear()
    send(mock, "R 1")
    for _ in range(4):
        advance(250)
        send(mock, "S")
    assert sum(l.startswith("R ") for l in out) == 3  # immediate + 2 periodic
    send(mock, "R 0")
    out.clear()
    advance(1500)
    assert not any(l.startswith("R ") for l in out)


def test_dry_run_readback_reports_no_signal():
    clock = Clock()
    out: list[str] = []
    mock = MockEsp32(emit=out.append, clock=clock, dry_run=True, arm_ms=0)
    mock.tick()
    send(mock, "R")
    assert out[-1].startswith("R [DRY RUN] left io1->io4: no signal (LOW) sent 1500")


def test_forward_only_esc_config():
    esc = EscConfig(bidirectional=False)
    assert (esc.neutral_us, esc.min_us, esc.max_us) == (1000, 1000, 1150)
    assert esc.value_to_us(-0.5) == 1000
    assert esc.value_to_us(0.1) == 1100
    assert esc.value_to_us(1.0) == 1150
