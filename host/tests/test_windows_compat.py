"""Things that broke (or could break) on Windows: Unix-only imports, signal handlers, MIME types."""

from __future__ import annotations

import asyncio
import mimetypes
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from bridge.__main__ import install_stop_handlers
from bridge.server import QuietHandler

HOST_DIR = Path(__file__).resolve().parents[1]


def test_mock_esp32_imports_without_unix_only_modules():
    """tty / termios do not exist on Windows: importing the mock must not need them."""
    code = "import sys; sys.modules['tty'] = None; sys.modules['termios'] = None; import bridge.mock_esp32"
    res = subprocess.run([sys.executable, "-c", code], cwd=HOST_DIR, capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


def test_stop_handlers_report_false_where_the_loop_has_no_signals():
    class WindowsLikeLoop:
        def add_signal_handler(self, *_args):
            raise NotImplementedError

    assert install_stop_handlers(WindowsLikeLoop(), asyncio.Event()) is False  # type: ignore[arg-type]


@pytest.mark.skipif(sys.platform == "win32", reason="add_signal_handler is Unix-only")
def test_stop_handlers_stop_the_bridge_on_sigint():
    async def go() -> bool:
        stop = asyncio.Event()
        assert install_stop_handlers(asyncio.get_running_loop(), stop) is True
        os.kill(os.getpid(), signal.SIGINT)
        await asyncio.wait_for(stop.wait(), timeout=2)
        return True

    assert asyncio.run(go())


def test_javascript_is_served_as_javascript_even_if_the_registry_says_text_plain(monkeypatch):
    """The browser refuses ES modules with a text/plain type (Windows registry quirk)."""
    mimetypes.init()
    monkeypatch.setitem(mimetypes.types_map, ".js", "text/plain")
    handler = object.__new__(QuietHandler)  # guess_type only needs the class attributes
    assert handler.guess_type("js/app.js") == "text/javascript"
    assert handler.guess_type("css/style.css") == "text/css"
    assert handler.guess_type("index.html") == "text/html"
