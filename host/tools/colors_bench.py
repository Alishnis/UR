"""Mission 5 colour benchmark: the pole detector on physics-based underwater frames (tests/underwater_sim.py).

    python -m tools.colors_bench              # summary table (run from host/)
    python -m tools.colors_bench --detail     # per condition
    python -m tools.colors_bench --images DIR # also save a contact sheet of the worst frames

For every combination of pool water (clear .. cloudy), depth, lamp colour, camera white balance (auto /
locked at the surface), background (open water / blue wall) and distance (0.5 .. 5 m) it renders the red,
yellow and blue poles and asks: does the Mission 5 logic (biggest tall blob of each colour, like
pickPoles in webgui/js/poles.js) point at the RIGHT pole? A pole is

    ok        the chosen blob of its colour is on it
    missed    no blob of its colour at all
    wrong     the chosen blob of its colour is somewhere else (the water, another pole)
    confused  some OTHER colour's chosen blob is on it (red pole called yellow, ...)

Detector variants, each with and without the water-colour balance: the defaults, and a "pool calibration"
made like the GUI does (click on each pole once at 1.5 m, 9 x 9 pixels). Without the balance that is the
old rule (range from the samples, tightened against the background); with it, the new widen-only rule.
At the end, a grey / white / black pipe alone near the camera: how often it is taken for a pole.
"""

from __future__ import annotations

import argparse
import itertools
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "tests"))

from underwater_sim import NEUTRALS, POLE_COLORS, Camera, PoleSpec, Water, render, three_poles  # noqa: E402

from vision import colors as vc  # noqa: E402

DISTANCES = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0)
GRID = {
    "turbidity": (0.03, 0.1, 0.3),
    "depth": (0.5, 1.5),
    "light": ("led4000", "daylight", "warm3000"),
    "wb": ("auto", "locked"),
    "wall": (None, 3.0),
    "gradient": (0.0, 1.5),
}
MIN_ASPECT = 1.2  # webgui config.js m5.minAspect
CAL_DISTANCE = 1.5


def widen_hue(a: list[int], b: list[int]) -> list[int]:
    """The shortest hue range (wrapping) that covers both a and b (webgui/js/colors.js widenRange)."""
    width = lambda r: (r[1] - r[0]) % 180  # noqa: E731
    ahead = lambda f, t: (t - f) % 180  # noqa: E731
    contains = lambda o, i: ahead(o[0], i[0]) + width(i) <= width(o)  # noqa: E731
    cands = [c for c in (a, b, [a[0], b[1]], [b[0], a[1]]) if contains(c, a) and contains(c, b)]
    return min(cands, key=width) if cands else [0, 179]


def balanced_calibration(name: str, samples: np.ndarray) -> dict:
    """webgui/js/colors.js calibrateBalanced: the default range, widened just enough to take in the clicked
    pole (its median hue +-3, 85 % of its median saturation and brightness); never narrower."""
    base = vc.DEFAULT_COLORS[name]
    px = samples.reshape(-1, 3).astype(np.float64)
    mid, _ = _circ_median(px[:, 0])
    pole = [int(np.floor(mid - 3)) % 180, int(np.ceil(mid + 3)) % 180]
    return {"h": widen_hue(base["h"], pole),
            "s": [min(base["s"][0], max(20, int(np.median(px[:, 1]) * 0.85))), 255],
            "v": [min(base["v"][0], max(25, int(np.median(px[:, 2]) * 0.85))), 255]}
# the detector's defaults before the water-colour balance (raw camera HSV, air values)
RAW_DEFAULTS = {
    "red": {"h": [170, 10], "s": [100, 255], "v": [70, 255]},
    "yellow": {"h": [18, 38], "s": [100, 255], "v": [100, 255]},
    "blue": {"h": [100, 130], "s": [150, 255], "v": [50, 255]},
}


# ---------- what the GUI does, in Python ----------

def pick_poles(blobs: list[dict]) -> dict:
    """webgui/js/poles.js pickPoles: per colour the blob with the best area x (tall ? 1 : 0.5)."""
    best: dict = {}
    for b in blobs:
        s = b["area"] * (1 if b["aspect"] >= MIN_ASPECT else 0.5)
        if b["color"] not in best or s > best[b["color"]][0]:
            best[b["color"]] = (s, b)
    return {k: v[1] for k, v in best.items()}


def _circ_median(hues: np.ndarray) -> tuple[float, np.ndarray]:
    a = hues * np.pi / 90
    mean = (np.degrees(np.arctan2(np.sin(a).sum(), np.cos(a).sum())) / 2) % 180
    d = (hues - mean + 90) % 180 - 90
    un = np.sort(mean + d)
    return float(np.median(un)), un


def range_from_samples(hsv: np.ndarray, sat_frac: float = 0.55, min_sat: int = 40, hue_margin: int = 10,
                       spread: bool = True) -> dict:
    """webgui/js/colors.js rangeFromSamples (hue: circular median +-10 widened to the 10..90 % spread;
    S lo = max(40, 0.55 median), V lo = max(25, 0.45 median))."""
    px = hsv.reshape(-1, 3).astype(np.float64)
    mid, un = _circ_median(px[:, 0])
    q = lambda p: un[min(len(un) - 1, max(0, round(p * (len(un) - 1))))]  # noqa: E731
    lo = max(min(mid - hue_margin, q(0.1) if spread else mid), mid - 45)
    hi = min(max(mid + hue_margin, q(0.9) if spread else mid), mid + 45)
    s, v = np.median(px[:, 1]), np.median(px[:, 2])
    return {"h": [int(np.floor(lo)) % 180, int(np.ceil(hi)) % 180],
            "s": [int(round(max(min_sat, s * sat_frac))), 255], "v": [int(round(max(25, v * 0.45))), 255]}


def tighten(rng: dict, samples: np.ndarray, hsv_bg: np.ndarray) -> dict:
    """webgui/js/vision_ui.js tightenAgainstBackground: raise S lo, then V lo, in steps of 5 until at
    most 2 % of the background matches, never above 90 % of the pole's own median."""
    r = {k: list(v) for k, v in rng.items()}
    cover = lambda r: (vc.color_mask(hsv_bg, r) > 0).mean()  # noqa: E731
    s_cap = np.median(samples[..., 1]) * 0.9
    v_cap = np.median(samples[..., 2]) * 0.9
    while cover(r) > 0.02 and r["s"][0] + 5 <= min(s_cap, r["s"][1]):
        r["s"][0] += 5
    while cover(r) > 0.02 and r["v"][0] + 5 <= min(v_cap, r["v"][1]):
        r["v"][0] += 5
    return r


def calibrate(img: np.ndarray, truths, balance: bool) -> dict:
    """Click once on the middle of each pole, as the pilot would."""
    work = vc.balanced(img) if balance else img
    hsv = cv2.cvtColor(work, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    small = cv2.cvtColor(cv2.resize(work, (128, 72), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
    colors = {}
    for t in truths:
        cx, cy = (int(round(v)) for v in t.center)
        patch = hsv[max(0, cy - 4):cy + 5, max(0, cx - 4):cx + 5]
        u = cx / w
        cols = np.abs((np.arange(128) + 0.5) / 128 - u) > 0.1
        if balance:
            colors[t.color] = balanced_calibration(t.color, patch)
        else:
            colors[t.color] = tighten(range_from_samples(patch), patch, small[:, cols])
    return colors


# ---------- scoring ----------

def on_pole(blob: dict, t, pad: float = 3.0) -> bool:
    x, y, w, h = t.box
    cx, cy = blob["center"]
    return x - pad <= cx <= x + w + pad and y - pad <= cy <= y + h + pad


def score_frame(blobs: list[dict], truths) -> dict[str, str]:
    picks = pick_poles(blobs)
    out = {}
    for t in truths:
        mine = picks.get(t.color)
        others = [c for c, b in picks.items() if c != t.color and on_pole(b, t)]
        if mine is not None and on_pole(mine, t):
            out[t.color] = "confused" if others else "ok"
        elif others:
            out[t.color] = "confused"
        elif mine is None:
            out[t.color] = "missed"
        else:
            out[t.color] = "wrong"
    return out


def conditions():
    keys = list(GRID)
    for vals in itertools.product(*(GRID[k] for k in keys)):
        yield dict(zip(keys, vals))


def run(variants: dict, *, detail: bool = False, images: Path | None = None, distances=DISTANCES):
    # tallies[variant][color][distance] -> {result: count}
    tallies = {v: defaultdict(lambda: defaultdict(lambda: defaultdict(int))) for v in variants}
    worst: dict[str, list] = defaultdict(list)
    for i, cond in enumerate(conditions()):
        water = Water(turbidity=cond["turbidity"], depth=cond["depth"], light=cond["light"],
                      gradient_m=cond["gradient"])
        cam = Camera(wb=cond["wb"])
        cal_img, cal_truth = render(three_poles(CAL_DISTANCE), water, cam, seed=i, wall_m=_wall(cond, CAL_DISTANCE))
        cals = {b: calibrate(cal_img, cal_truth, b) for b in (False, True)}
        for z in distances:
            img, truths = render(three_poles(z), water, cam, seed=1000 + i, wall_m=_wall(cond, z))
            for name, (balance, calibrated) in variants.items():
                params = {"balance": balance}
                if calibrated:
                    params["colors"] = cals[balance]
                elif not balance:
                    params["colors"] = RAW_DEFAULTS
                res = score_frame(vc.detect_colors(img, params)["blobs"], truths)
                for color, r in res.items():
                    tallies[name][color][z][r] += 1
                    if r != "ok":
                        worst[name].append((cond, z, color, r, img))
                if detail:
                    bad = {c: r for c, r in res.items() if r != "ok"}
                    if bad:
                        print(f"{name:22s} {_cond_text(cond)} z={z}: {bad}")
    if images:
        _save_sheets(images, worst)
    return tallies


def _wall(cond: dict, z: float) -> float | None:
    return None if cond["wall"] is None else z + cond["wall"]


def _cond_text(c: dict) -> str:
    return (f"b={c['turbidity']:<4} depth={c['depth']} {c['light']:8s} wb={c['wb']:6s} "
            f"{'wall' if c['wall'] else 'open'} grad={c['gradient']}")


def _save_sheets(folder: Path, worst: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, items in worst.items():
        tiles = []
        for cond, z, color, r, img in items[:24]:
            t = cv2.resize(img, (320, 180))
            cv2.putText(t, f"{color} {r} z={z} {cond['wb']} b={cond['turbidity']}", (4, 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 2)
            cv2.putText(t, f"{color} {r} z={z} {cond['wb']} b={cond['turbidity']}", (4, 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
            tiles.append(t)
        if tiles:
            while len(tiles) % 4:
                tiles.append(np.zeros_like(tiles[0]))
            sheet = np.vstack([np.hstack(tiles[k:k + 4]) for k in range(0, len(tiles), 4)])
            cv2.imwrite(str(folder / f"{name}.jpg"), sheet)


def run_neutrals(variants: dict, distances=(0.4, 0.8, 1.5)) -> dict:
    """A grey / white / black pole ALONE in the picture: every colour picked on it is a false pick
    (the pilot would be sent to the wrong pole). -> {variant: {neutral: (false picks, frames)}}"""
    out = {v: {n: [0, 0] for n in NEUTRALS} for v in variants}
    for i, cond in enumerate(conditions()):
        water = Water(turbidity=cond["turbidity"], depth=cond["depth"], light=cond["light"],
                      gradient_m=cond["gradient"])
        cam = Camera(wb=cond["wb"])
        cal_img, cal_truth = render(three_poles(CAL_DISTANCE), water, cam, seed=i, wall_m=_wall(cond, CAL_DISTANCE))
        cals = {b: calibrate(cal_img, cal_truth, b) for b in (False, True)}
        for z in distances:
            for n in NEUTRALS:
                img, (t,) = render([PoleSpec(n, 0.0, z)], water, cam, seed=2000 + i, wall_m=_wall(cond, z))
                for name, (balance, calibrated) in variants.items():
                    params = {"balance": balance}
                    if calibrated:
                        params["colors"] = cals[balance]
                    elif not balance:
                        params["colors"] = RAW_DEFAULTS
                    picks = pick_poles(vc.detect_colors(img, params)["blobs"])
                    out[name][n][0] += any(on_pole(b, t) for b in picks.values())
                    out[name][n][1] += 1
    return out


def summary(tallies: dict, distances=DISTANCES) -> str:
    lines = []
    head = f"{'variant':24s} {'colour':7s} " + " ".join(f"{z:>5.1f}m" for z in distances) + "   wrong/confused"
    lines.append(head)
    for name, by_color in tallies.items():
        for color in POLE_COLORS:
            cells, bad = [], 0
            for z in distances:
                d = by_color[color][z]
                n = sum(d.values())
                cells.append(f"{100 * d['ok'] / n:5.0f}%" if n else "    - ")
                bad += d["wrong"] + d["confused"]
            lines.append(f"{name:24s} {color:7s} " + " ".join(cells) + f"   {bad}")
    return "\n".join(lines)


VARIANTS = {
    "defaults": (False, False),
    "calibrated": (False, True),
    "balanced+defaults": (True, False),
    "balanced+calibrated": (True, True),
}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--detail", action="store_true", help="print every frame that is not all ok")
    ap.add_argument("--images", type=Path, help="save contact sheets of the failures here")
    ap.add_argument("--no-neutrals", action="store_true", help="skip the grey / white / black pole test")
    a = ap.parse_args(argv)
    n = len(list(conditions()))
    print(f"{n} pool conditions x {len(DISTANCES)} distances x 3 poles; 'ok' = the Mission 5 pick is the right pole\n")
    print(summary(run(VARIANTS, detail=a.detail, images=a.images)))
    if not a.no_neutrals:
        print("\nA grey / white / black pole alone at 0.4, 0.8, 1.5 m: frames where it is picked as a colour")
        for name, by in run_neutrals(VARIANTS).items():
            print(f"{name:24s} " + "  ".join(f"{n} {f}/{t}" for n, (f, t) in by.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
