"""Bridge settings. Everything here can also be overridden on the command line (python -m bridge --help)."""

# Serial port of the ESP32. "auto" picks the first USB serial port (the name changes between plug-ins on macOS,
# e.g. /dev/cu.usbmodem5C834087141). Give an exact name with --port if several boards are plugged in.
SERIAL_PORT = "auto"
PORT_PATTERNS = ("usbmodem", "usbserial", "wchusbserial", "SLAB_USBtoUART", "ttyUSB", "ttyACM")

# Must match the ESP firmware (monitor_speed in platformio.ini).
SERIAL_BAUD = 115200

# The browser GUI connects here. localhost only: nobody else on the network can drive the ROV.
HOST = "localhost"
HTTP_PORT = 8000  # serves host/webgui -> open http://localhost:8000
WS_PORT = 8765  # control: text lines forwarded to / from the serial port
VISION_PORT = 8766  # AprilTag: JPEG frames in, detections out

# Mission 2.1
EXPECTED_TAGS = 3
CONFIRM_FRAMES = 5
