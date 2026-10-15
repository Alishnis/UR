"""The mock's body splitting must equal the firmware's (src/mission1_text.h, compiled natively)."""

from __future__ import annotations

import random
import shutil
import subprocess
from pathlib import Path

import pytest

from bridge.mock_mission1 import MAX_GOT_LINE_LEN, MAX_GOT_LINES, body_lines

ROOT = Path(__file__).resolve().parents[2]
DUMP_SRC = ROOT / "tests" / "firmware" / "lines_dump.cpp"


@pytest.fixture(scope="module")
def dump_bin(tmp_path_factory) -> Path:
    cxx = shutil.which("c++") or shutil.which("clang++") or shutil.which("g++")
    if not cxx:
        pytest.skip("no C++ compiler")
    out = tmp_path_factory.mktemp("m1twin") / "lines_dump"
    subprocess.run([cxx, "-std=c++17", "-O1", "-o", str(out), str(DUMP_SRC)], check=True)
    return out


def _bodies(seed: int) -> list[bytes]:
    rnd = random.Random(seed)
    out = [
        b"",
        b"\n",
        b"Congratulations!!! This is the WiFi API task message for the fall training.",
        b"one\r\n\r\n  two  \n\n\nthree",
        b"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv\nw",  # 23 lines
        b"x" * 700,
        b"caf\xc3\xa9 \x01ok\x7f\xff",
        b"\t \t",
    ]
    alphabet = b"abc XYZ\r\n\t\x00\x01\xe9\x7f~"
    for _ in range(3000):
        n = rnd.choice([0, 1, 5, 40, 300, 700])
        out.append(bytes(rnd.choice(alphabet) for _ in range(n)))
    return out


def test_mock_body_split_matches_firmware(dump_bin: Path) -> None:
    bodies = _bodies(7)
    res = subprocess.run([str(dump_bin)], input="\n".join(b.hex() for b in bodies) + "\n",
                         capture_output=True, text=True, check=True)
    fw = res.stdout.splitlines()
    assert len(fw) == len(bodies)
    bad = []
    for body, got in zip(bodies, fw):
        lines, dropped = body_lines(body, MAX_GOT_LINES, MAX_GOT_LINE_LEN)
        want = "\t".join(lines) + f"|{len(lines)}|{dropped}"
        if want != got:
            bad.append((body[:60], got[:80], want[:80]))
    assert not bad, f"first mismatches: {bad[:3]}"
