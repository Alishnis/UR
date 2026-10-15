"""Tiny HTTP server that plays the competition tower, for testing Mission 1 on the desk.

    cd host
    .venv/bin/python -m tools.m1_server                 # serves on 0.0.0.0:8080
    .venv/bin/python -m tools.m1_server --text "hello"  # custom message

The laptop and the ESP32 must be on the SAME 2.4 GHz Wi-Fi network (phone hotspot works).
Use one of the printed URLs in the GUI (or `U <url>` over serial). Every request is logged
with the client's IP and User-Agent: the ESP32's HTTPClient says "ESP32HTTPClient", a browser
does not. That tells you who really fetched the text (a laptop or phone fetching scores 0).

macOS asks once whether Python may accept incoming connections: allow it.
"""

from __future__ import annotations

import argparse
import http.server
import socket
import sys
import time

from bridge.mock_mission1 import SAMPLE_TEXT


def local_ips() -> list[str]:
    """IPv4 addresses of this laptop, the default-route one first."""
    ips: list[str] = []
    try:  # no packet is sent: connect() on UDP only picks the outgoing interface
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips


def make_handler(text: str):
    body = (text + "\n").encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"  # close after each answer, like a simple tower

        def do_GET(self) -> None:
            ua = self.headers.get("User-Agent", "-")
            who = "ESP32" if "ESP32" in ua else "NOT an ESP32"
            print(f"{time.strftime('%H:%M:%S')}  GET {self.path}  from {self.client_address[0]}  "
                  f"UA={ua!r}  -> {who}", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            pass

    return Handler


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", default=SAMPLE_TEXT, help="message to serve (default: the manual's sample)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default: all interfaces)")
    args = ap.parse_args(argv)

    try:
        server = http.server.ThreadingHTTPServer((args.host, args.port), make_handler(args.text))
    except OSError as e:
        print(f"Cannot listen on {args.host}:{args.port}: {e}")
        return 1
    print(f"Mission 1 test server, serving: {args.text!r}")
    ips = local_ips()
    if ips:
        print("Use one of these URLs (same Wi-Fi as the ESP32):")
        for ip in ips:
            print(f"  http://{ip}:{args.port}/")
    else:
        print(f"No network address found; the URL is http://<laptop ip>:{args.port}/")
    print("Waiting for requests, Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
