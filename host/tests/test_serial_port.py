"""Port auto-detection: the COM/UART port must win over the native USB port."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from bridge import serial_port


def fake_ports(monkeypatch, ports):
    monkeypatch.setattr(
        serial_port.list_ports, "comports",
        lambda: [SimpleNamespace(device=d, vid=v, description="x") for d, v in ports],
    )


def test_native_usb_is_detected(monkeypatch):
    fake_ports(monkeypatch, [("/dev/cu.usbmodem101", 0x303A), ("/dev/cu.usbmodemABC", 0x1A86)])
    assert serial_port.is_native_usb("/dev/cu.usbmodem101")
    assert not serial_port.is_native_usb("/dev/cu.usbmodemABC")
    assert not serial_port.is_native_usb("/dev/cu.nothing")


def test_uart_port_is_preferred_over_native_usb(monkeypatch):
    fake_ports(monkeypatch, [("/dev/cu.usbmodem101", 0x303A), ("/dev/cu.usbmodem5C83", 0x1A86)])
    assert serial_port.candidate_ports() == ["/dev/cu.usbmodem5C83", "/dev/cu.usbmodem101"]
    assert serial_port.find_port() == "/dev/cu.usbmodem5C83"


def test_two_uart_ports_need_an_explicit_choice(monkeypatch):
    fake_ports(monkeypatch, [("/dev/cu.usbserial-1", 0x10C4), ("/dev/cu.usbmodem5C83", 0x1A86)])
    with pytest.raises(serial_port.PortError):
        serial_port.find_port()


def test_single_native_port_is_still_found_so_the_bridge_can_warn(monkeypatch):
    fake_ports(monkeypatch, [("/dev/cu.usbmodem101", 0x303A), ("/dev/cu.Bluetooth-Incoming-Port", None)])
    assert serial_port.find_port() == "/dev/cu.usbmodem101"


def test_builtin_macos_ports_are_never_candidates(monkeypatch):
    fake_ports(monkeypatch, [("/dev/cu.Bluetooth-Incoming-Port", None), ("/dev/cu.debug-console", None)])
    assert serial_port.candidate_ports() == []
