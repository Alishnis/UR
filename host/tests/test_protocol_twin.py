"""Differential test: the Python mock must parse every line exactly like the
firmware (src/protocol.h, compiled natively from tests/firmware/parse_dump.cpp)."""

from __future__ import annotations

import random
import shutil
import subprocess
from pathlib import Path

import pytest

from bridge.mock_esp32 import MAX_LINE, EscConfig, parse_line

ROOT = Path(__file__).resolve().parents[2]
DUMP_SRC = ROOT / "tests" / "firmware" / "parse_dump.cpp"

VALID = [
    "D 0 0 0", "D 0.100 -0.250 1.000", "D -1 1 -0", "D +.5 -.5 1.", "S", "P", "G", "L", " L\t",
    "R", "R 1", "R 0", "M UR_Field 12345678", "M Net pass with spaces", "M Open",
    "U http://192.168.4.1/t.txt", "U https://x/y", "D 0.001 -0.001 0.0005",
    "D 0.3 0.31 -0.299", "D 1.0000 -1.000 0.999",
]
ALPHABET = "DSPRMUGLdx 0123456789.+-\t,eEnaifhtp:/_"


def _fuzz_lines(n: int, seed: int) -> list[str]:
    rnd = random.Random(seed)
    out = list(VALID)
    for _ in range(n):
        kind = rnd.random()
        if kind < 0.4:  # mutate a valid line
            s = list(rnd.choice(VALID))
            for _ in range(rnd.randint(1, 3)):
                op = rnd.random()
                pos = rnd.randrange(len(s) + 1)
                if op < 0.4:
                    s.insert(pos, rnd.choice(ALPHABET))
                elif op < 0.7 and s:
                    del s[min(pos, len(s) - 1)]
                elif s:
                    s[min(pos, len(s) - 1)] = rnd.choice(ALPHABET)
            line = "".join(s)
        elif kind < 0.7:  # random D with random numbers
            nums = []
            for _ in range(rnd.randint(1, 4)):
                v = rnd.uniform(-1.3, 1.3)
                nums.append(rnd.choice([f"{v:.3f}", f"{v:.1f}", f"{v:.6f}", str(round(v)), f"{v:+.2f}"]))
            sep = rnd.choice([" ", "  ", "\t", " \t "])
            line = rnd.choice(["D", " D", "D "]) + sep + sep.join(nums) + rnd.choice(["", " ", "\t"])
        else:  # pure noise
            line = "".join(rnd.choice(ALPHABET) for _ in range(rnd.randint(0, 30)))
        out.append(line[:MAX_LINE])
    # Every 3-decimal value the GUI can send, for the rounding path.
    for k in range(-1000, 1001):
        v = k / 1000
        out.append(f"D {v:.3f} {-v:.3f} {v / 2:.3f}")
    return out


def _python_dump(line: str, esc: EscConfig) -> str:
    c = parse_line(line)
    drive = c.type == "drive"
    vals = c.values if drive else (0.0, 0.0, 0.0)
    us = [esc.value_to_us(v) for v in vals] if drive else [0, 0, 0]
    report = c.report if c.type == "report" else -1
    fv = "|".join(f"{v:.9g}" for v in vals)
    return f"{c.type}|{fv}|{report}|{c.ssid}|{c.password}|{c.url}|{us[0]}|{us[1]}|{us[2]}"


@pytest.fixture(scope="module")
def dump_bin(tmp_path_factory) -> Path:
    cxx = shutil.which("c++") or shutil.which("clang++") or shutil.which("g++")
    if not cxx:
        pytest.skip("no C++ compiler")
    out = tmp_path_factory.mktemp("twin") / "parse_dump"
    subprocess.run([cxx, "-std=c++17", "-O1", "-o", str(out), str(DUMP_SRC)], check=True)
    return out


def test_python_mock_parses_like_firmware(dump_bin: Path) -> None:
    lines = _fuzz_lines(20000, seed=1234)
    res = subprocess.run([str(dump_bin)], input="\n".join(lines) + "\n",
                         capture_output=True, text=True, check=True)
    fw = res.stdout.splitlines()
    assert len(fw) == len(lines)
    esc = EscConfig()
    mismatches = [(l, f, p) for l, f in zip(lines, fw) if f != (p := _python_dump(l, esc))]
    assert not mismatches, "first mismatches:\n" + "\n".join(
        f"  line={l!r}\n    fw={f}\n    py={p}" for l, f, p in mismatches[:5])
    # Sanity: the fuzz set really exercises both accepted and rejected lines.
    kinds = {f.split("|", 1)[0] for f in fw}
    assert {"drive", "invalid", "stop", "ping", "report", "wifi", "url", "get", "scan"} <= kinds
