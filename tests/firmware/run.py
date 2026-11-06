"""Build and run the native firmware tests on the laptop (Windows, macOS, Linux).

    python tests/firmware/run.py

Needs a C++17 compiler (c++, g++ or clang++) on PATH. On Windows install MSYS2/MinGW-w64
(`pacman -S mingw-w64-ucrt-x86_64-gcc`) or LLVM, and run this from a shell where `g++` works.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTS = ("test_protocol", "test_mission1_text", "test_timing")
EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""


def find_compiler() -> str | None:
    return shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")


def main() -> int:
    cxx = find_compiler()
    if cxx is None:
        print("No C++ compiler (c++, g++ or clang++) found on PATH.", file=sys.stderr)
        return 2
    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        for name in TESTS:
            exe = Path(tmp) / (name + EXE_SUFFIX)
            subprocess.run([cxx, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-o", str(exe), str(HERE / (name + ".cpp"))],
                           check=True, cwd=HERE)
            print(f"== {name}", flush=True)
            if subprocess.run([str(exe)], cwd=HERE).returncode != 0:
                failed.append(name)
    if failed:
        print("FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
