"""Find the ESP32 serial port by pattern (the name changes between plugs)."""

from __future__ import annotations

from serial.tools import list_ports

# USB vendor ids of the USB-UART bridges found on ESP32 boards.
KNOWN_VIDS = {
    0x303A: "Espressif native USB",
    0x1A86: "WCH CH34x",
    0x10C4: "Silicon Labs CP210x",
    0x0403: "FTDI",
}

NATIVE_USB_VID = 0x303A

# Device-name fragments, for ports that report no vendor id.
NAME_PATTERNS = ("usbmodem", "usbserial", "wchusbserial", "SLAB_USBtoUART", "ttyUSB", "ttyACM")

# Never pick these (macOS built-ins).
EXCLUDE = ("Bluetooth", "debug-console")


class PortError(RuntimeError):
    pass


def candidate_ports() -> list[str]:
    found = []
    for p in list_ports.comports():
        if any(x in p.device for x in EXCLUDE):
            continue
        if p.vid in KNOWN_VIDS or any(x in p.device for x in NAME_PATTERNS):
            found.append(p.device)
    # Prefer the COM/UART port (firmware Serial lives there) over the native USB port,
    # and on macOS /dev/cu.* over /dev/tty.* (tty.* blocks on open).
    found.sort(key=lambda d: (is_native_usb(d), not d.startswith("/dev/cu."), d))
    return found


def is_native_usb(device: str) -> bool:
    """True for the ESP32-S3's native USB port (Espressif VID 0x303A).

    The firmware's Serial is on UART0, i.e. the board's COM/UART port, not on this one.
    """
    return any(p.device == device and p.vid == NATIVE_USB_VID for p in list_ports.comports())


def describe_ports() -> str:
    lines = [f"  {p.device}  ({p.description})" for p in list_ports.comports()]
    return "\n".join(lines) if lines else "  (none)"


def find_port(explicit: str | None = None) -> str:
    """Return the port to use, or raise PortError with a helpful message."""
    if explicit:
        return explicit
    ports = candidate_ports()
    uart_ports = [p for p in ports if not is_native_usb(p)]
    if len(uart_ports) == 1:  # the COM/UART port wins even if the native USB port is plugged too
        return uart_ports[0]
    if len(ports) == 1:
        return ports[0]
    if not ports:
        raise PortError(
            "No ESP32 serial port found. Check the USB cable (COM/UART port of the board)."
            "\nAll ports:\n" + describe_ports()
        )
    raise PortError(
        "Several possible ESP32 ports, pass --port explicitly:\n"
        + "\n".join(f"  {p}" for p in ports)
    )
