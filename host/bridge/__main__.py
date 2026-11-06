"""Run the bridge:  python -m bridge [--mock] [--port COM5 | /dev/cu.usbmodemXXXX | /dev/ttyACM0]"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from bridge.server import Bridge


def install_stop_handlers(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> bool:
    """Make Ctrl+C / SIGTERM set `stop`. Returns False where the loop cannot do it (Windows).

    There asyncio.run() turns Ctrl+C into a cancelled main task and amain() cleans up in `finally`.
    """
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
    except NotImplementedError:  # Windows event loops have no add_signal_handler
        return False
    return True


async def amain(args: argparse.Namespace) -> None:
    bridge = Bridge(
        mock=args.mock,
        serial_port=args.port,
        host=args.host,
        http_port=args.http_port,
        ws_port=args.ws_port,
        mock_arm_ms=args.mock_arm_ms,
        mock_dry_run=args.mock_dry_run,
        vision=not args.no_vision,
        vision_port=args.vision_port,
    )
    await bridge.start()
    mode = "MOCK ESP32 (no hardware)" if args.mock else "serial " + (args.port or "(auto-detect)")
    print(f"ROV bridge, {mode}")
    print(f"  GUI:        http://localhost:{bridge.http_port}/")
    print(f"  WebSocket:  ws://localhost:{bridge.ws_port}/")
    print(f"  Vision:     {bridge.vision_status()}")
    print("Ctrl+C to stop (motors are set to neutral first).")

    stop = asyncio.Event()
    install_stop_handlers(asyncio.get_running_loop(), stop)
    try:
        await stop.wait()
    finally:  # also runs when Ctrl+C cancels this task (Windows): motors must be set to neutral
        print("\nStopping...")
        await bridge.stop()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bridge", description=__doc__)
    ap.add_argument("--mock", action="store_true", help="fake ESP32, no hardware needed")
    ap.add_argument("--mock-dry-run", action="store_true", help="mock behaves like DRY_RUN firmware")
    ap.add_argument("--mock-arm-ms", type=int, default=4000, help="mock arming time (default 4000)")
    ap.add_argument("--port", help="serial port (default: auto-detect)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default: this laptop only)")
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--vision-port", type=int, default=8766, help="camera vision WebSocket (default 8766)")
    ap.add_argument("--no-vision", action="store_true", help="do not start the camera vision service")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:  # Windows: Ctrl+C after the clean-up in amain()
        pass
    except OSError as e:
        print(f"Cannot start: {e}\nIs another bridge already running on these ports?")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
