"""Mission 3: the dark line on the pool floor and the white tapes across it.

Idea: "darker than the floor around it", not "black". Underwater a black line turns dark blue-green and
the light changes along the pool, so a fixed colour threshold breaks. A morphological closing with a
kernel wider than the line paints the line over with the surrounding floor; (closing - image) / closing
= how much darker each pixel is than its neighbourhood, relative to the local light (so a dim corner of
the pool does not hide the line). Dark pieces lying on one straight line are one line broken by tapes:
walking along it, a tape is a gap that is clearly NOT dark. A tape at an END of the line (the final tape
when the line ends there, or the start tape when the line begins there) is found by being brighter than
the floor just past that end. The GUI counts every tape it sees cross its trigger row, start tape included.

Stateless, simplified port of the team's earlier vision/line_detector.py.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from vision.frames import mask_data_url, param_bool, param_number, round1, round_point, round_points

# Two passes on downscaled copies (the line is wide, speed matters more): (work width, closing kernel as a
# fraction of it, minimum length / width of a dark piece). The kernel must be wider than the line, so the
# fine pass misses a line wider than ~13 % of the frame (ROV low over it; it sees the line's edges at most).
# The coarse pass sees lines up to ~30 % of the frame, of which only a short, wide stretch is in view, but
# uneven light fools it more easily, so its line is used only when the fine pass cannot have seen it.
PASSES = ((480, 0.15, 3.0), (240, 0.45, 2.0))
WIDE_LINE_FRAC = 0.11  # a line at least this wide (fraction of the frame width) is taken from the coarse pass
MAX_EDGE_CUT = 0.3  # coarse pass: drop a line whose width runs into the image border this often (dim edges)
SMOOTH_SIGMA = 1.5  # px (work size) of noise blur: sensor noise is per pixel, the line is several px wide
BRIGHT_SIGMA = 0.7  # less blur for the tape brightness: a far tape is only 2-3 px long
DIM_FLOOR = 48  # darkness is relative to the local floor brightness, but never to less than this (noise)
REL_THRESH = 0.45  # dark pixel: also at least this fraction of the darkest line-like pixels in the frame
MAX_PIECES = 20
MIN_PIECE_AREA = 6  # px (work size)
MIN_LENGTH_FRAC = 0.06  # shortest line reported, fraction of the work image diagonal
# a line must be clearly dark along its whole length, not only at its darkest pixels: tile joints and the
# shade between caustic ripples are 10-20 % darker than the floor (25-55 on this 0..255 scale), a black
# line seen through a few metres of pool water 45-80 % (110-200). Lower darkThresh in murky water.
MIN_LINE_DARK = 3.0  # x darkThresh
GROUP_ANGLE_DEG = 12.0  # pieces this parallel and close to one axis are one line broken by tapes
MAX_GAP_FRAC = 0.25  # a gap longer than this fraction of the visible line is not a tape
TAPE_MAX_DARK = 0.4  # inside a tape the darkness drops below this fraction of the line's darkness
# far-end tape: a band across the line end, brighter than the floor (0..255 relative to the floor, i.e.
# ~6 % brighter) across the line width, and ~8 % brighter at its best row. A white tape on a
# light blue floor is only 15-30 % brighter, so these are low on purpose; the shape rules do the rest.
END_TAPE_BRIGHT = 15.0
END_TAPE_PEAK = 20.0


def line_params(params: dict) -> dict:
    return {
        "darkThresh": param_number(params, "darkThresh", 25.0, 5.0, 120.0),
        "refRow": param_number(params, "refRow", 0.75, 0.3, 0.95),
        "mask": param_bool(params, "mask", False),
    }


def fit_line(pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Centre, unit main direction, length and width of a point cloud (uniform bar: L = sqrt(12 var))."""
    c = pts.mean(axis=0)
    cov = np.cov((pts - c).T) if len(pts) > 1 else np.eye(2)
    vals, vecs = np.linalg.eigh(cov)
    return c, vecs[:, 1], float(np.sqrt(12 * max(vals[1], 0))), float(np.sqrt(12 * max(vals[0], 0)))


def _dist_to_line(p: np.ndarray, c: np.ndarray, d: np.ndarray) -> float:
    v = p - c
    return float(abs(v[0] * d[1] - v[1] * d[0]))


def _clip_segment(a: np.ndarray, b: np.ndarray, w: float, h: float) -> tuple[np.ndarray, np.ndarray]:
    """Segment a-b cut to the image rectangle [0, w] x [0, h] (unchanged if it misses it entirely)."""
    d = b - a
    t0, t1 = 0.0, 1.0
    for p, q in ((-d[0], a[0]), (d[0], w - a[0]), (-d[1], a[1]), (d[1], h - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return a, b
            continue
        r = q / p
        if p < 0:
            t0 = max(t0, r)
        else:
            t1 = min(t1, r)
    if t0 > t1:
        return a, b
    return a + t0 * d, a + t1 * d


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index ranges where flags is True."""
    padded = np.r_[False, flags, False].astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))


def _relative_maps(bgr: np.ndarray, work_width: int, kernel_frac: float) -> tuple[np.ndarray, np.ndarray, float]:
    """Work-size darkness and brightness maps (0..255, relative to the local floor) and the scale work/bgr."""
    h, w = bgr.shape[:2]
    ww = min(work_width, w)
    scale = ww / w
    hh = max(1, round(h * scale))
    small = cv2.resize(bgr, (ww, hh), interpolation=cv2.INTER_AREA) if ww != w else bgr
    # brightest channel: the blue floor stays bright, a black line stays dark in every channel
    raw = cv2.max(cv2.max(small[..., 0], small[..., 1]), small[..., 2]) if small.ndim == 3 else small
    v = cv2.GaussianBlur(raw, (0, 0), SMOOTH_SIGMA)
    k = max(3, int(ww * kernel_frac) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    no_dark = cv2.morphologyEx(v, cv2.MORPH_CLOSE, kernel)  # dark features (the line) painted over
    # then bright ones (tapes) too: a plain opening would be pulled down to the line's level next to it
    floor = np.maximum(cv2.morphologyEx(no_dark, cv2.MORPH_OPEN, kernel).astype(np.float32), DIM_FLOOR)
    no_dark = no_dark.astype(np.float32)
    dark = (no_dark - v) * 255 / np.maximum(no_dark, DIM_FLOOR)
    # (noise in the lightly blurred brightness is removed later by a median across the line)
    bright = (cv2.GaussianBlur(raw, (0, 0), BRIGHT_SIGMA).astype(np.float32) - floor) * 255 / floor
    return np.clip(dark, 0, 255), np.clip(bright, 0, 255), scale


def _sample_strip(img: np.ndarray, c, d, nrm, ts: np.ndarray, ss: np.ndarray) -> np.ndarray:
    """img sampled on a grid along the axis (rows = ts) and across it (cols = ss); 0 outside the image."""
    grid = c + ts[:, None, None] * d + ss[None, :, None] * nrm
    mx, my = grid[..., 0].astype(np.float32), grid[..., 1].astype(np.float32)
    return cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def _profile(pts: np.ndarray, dark: np.ndarray, bright: np.ndarray, thresh: float) -> dict | None:
    """Walk along the fitted axis and read where it is dark (line), where not (tapes) and where it ends."""
    c, d, _, width = fit_line(pts)
    if d[1] < 0:
        d = -d  # point down the image: t grows towards the ROV
    nrm = np.array([-d[1], d[0]])
    t = (pts - c) @ d
    t0, t1 = float(t.min()), float(t.max())
    # look past the ends: a short piece of line behind a tape is too stubby to be found as a piece itself
    pad = max(10.0, 0.3 * (t1 - t0))
    ts = np.arange(t0 - pad, t1 + pad + 1.0)
    half = max(3.0, 1.5 * width)
    ss = np.arange(-half, half + 1.0)
    strip = _sample_strip(dark, c, d, nrm, ts, ss)
    profile = strip.max(axis=1)
    is_dark = profile > 0.8 * thresh
    core = (ts >= t0) & (ts <= t1)
    if not (is_dark & core).any():
        return None
    line_dark = float(np.median(profile[is_dark & core]))
    runs = []
    for a, b in _runs(is_dark):
        if core[a:b].any():
            runs.append((a, b))
        # outside the pieces only line-like runs count (not a thin crossing joint or a faint shadow)
        elif b - a >= max(2.0, 0.5 * width) and np.median(profile[a:b]) >= 0.5 * line_dark:
            runs.append((a, b))
    if not runs:
        return None
    total = runs[-1][1] - runs[0][0]
    tapes = []
    for (_, a_end), (b_start, _) in zip(runs[:-1], runs[1:]):
        # a tape is clearly NOT dark (floor level or brighter); noise or murk only makes the line a bit lighter
        if (b_start - a_end <= max(3, MAX_GAP_FRAC * total)
                and profile[a_end:b_start].min() < TAPE_MAX_DARK * line_dark):
            tapes.append(c + d * ts[(a_end + b_start) // 2])
    keep = np.zeros(len(ts), bool)
    for a, b in runs:
        keep[a:b] = True
    # width = where it is at least half as dark as the line centre (independent of the threshold)
    rows = strip[keep]
    half_dark = rows >= 0.5 * rows.max(axis=1, keepdims=True)
    counts = half_dark.sum(axis=1)
    # how often the dark width runs into the image border: then the line's real width and centre are unknown
    # (a band of shade along a dim image edge looks like that too)
    outside = _sample_strip(np.ones_like(dark), c, d, nrm, ts[keep], ss) < 0.99
    near_out = outside | np.roll(outside, 1, axis=1) | np.roll(outside, -1, axis=1)
    edge_cut = float((half_dark & near_out).any(axis=1).mean())
    far_i, near_i = runs[0][0], runs[-1][1] - 1  # small t = top of the image = far from the ROV
    far, near = c + d * ts[far_i], c + d * ts[near_i]
    hh, ww = dark.shape
    med_width = float(np.median(counts))
    far_tape = _end_tape(bright, far, d, nrm, med_width, (ww, hh))
    if far_tape is not None:
        tapes.insert(0, far_tape)
    near_tape = _end_tape(bright, near, -d, nrm, med_width, (ww, hh))  # outwards = down the image
    if near_tape is not None:
        tapes.append(near_tape)
    return {"near": near, "far": far, "width": float(np.median(counts)), "tapes": tapes,
            "darkness": float(profile[keep].mean()), "length": float(np.linalg.norm(near - far)),
            "coverage": float(keep.sum()) / max(1, total), "edgeCut": edge_cut}


def _end_tape(bright, far, d, nrm, width, size) -> np.ndarray | None:
    """Centre of a bright band just past the end `far` of the line (d points from that end INTO the line),
    if that end is inside the image."""
    ww, hh = size
    margin = 3.0

    def inside(p) -> bool:
        return margin <= p[0] <= ww - 1 - margin and margin <= p[1] <= hh - 1 - margin

    if not inside(far):
        return None  # the line is cut by the image border there: its real end is not visible
    ts = -np.arange(0.0, max(6.0, 3.0 * width) + 1.0)  # from the far end outwards (up the image)
    n_in = next((i for i, t in enumerate(ts) if not inside(far + d * t)), len(ts))
    if n_in < max(4.0, width):
        return None  # too little floor visible past the end to tell
    ts = ts[:n_in]
    half = max(1.0, 0.5 * width)
    # median across the line width: a tape spans the whole line, a caustic speck or a stray reflection does not
    rows = np.median(_sample_strip(bright, far, d, nrm, ts, np.arange(-half, half + 1.0)), axis=1)
    lit = rows > END_TAPE_BRIGHT
    seam = max(5, int(0.35 * width))  # blur between the end of the dark run and the start of the band
    if not lit[:seam].any():
        return None  # the band must touch the end of the dark line
    start = int(np.argmax(lit))
    length = _runs(lit[start:])[0][1]
    if length < max(2.0, 0.15 * width) or start + length >= n_in:
        return None  # too short, or bright as far as we can see: a lit patch of floor, not a tape
    if rows[start:start + length].max() < END_TAPE_PEAK:
        return None
    return far + d * ts[start + length // 2]


def _find_lines(bgr: np.ndarray, dark_thresh: float, work_width: int, kernel_frac: float, min_elongation: float,
                reject_cut: bool) -> dict:
    """One detection pass: line candidates (work px, best first), scale work/bgr, dark mask, work size."""
    dark, bright, scale = _relative_maps(bgr, work_width, kernel_frac)
    hh, ww = dark.shape
    peak = float(np.percentile(dark, 99.7))
    thresh = max(dark_thresh, REL_THRESH * peak)
    mask = (dark > thresh).astype(np.uint8)
    found = {"cands": [], "scale": scale, "mask": mask, "size": (ww, hh)}
    if hh < 8 or ww < 8:
        return found

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    order = np.argsort(-stats[1:, cv2.CC_STAT_AREA])[:MAX_PIECES] + 1
    pieces = []  # (points Nx2, centre, direction, width)
    for i in order:
        if stats[i, cv2.CC_STAT_AREA] < MIN_PIECE_AREA:
            break
        x, y, bw, bh = (int(v) for v in stats[i, :4])
        ys, xs = np.nonzero(labels[y:y + bh, x:x + bw] == i)
        pts = np.c_[xs + x, ys + y].astype(np.float64)
        c, d, length, width = fit_line(pts)
        if length >= 4 and length / max(width, 1.0) >= min_elongation:
            pieces.append((pts, c, d, width))

    cos_tol = math.cos(math.radians(GROUP_ANGLE_DEG))
    used = [False] * len(pieces)
    cands = []
    for i, (pts, c, d, _) in enumerate(pieces):
        if used[i]:
            continue
        used[i] = True
        group = [pts]
        for j in range(i + 1, len(pieces)):  # collinear pieces = one line broken by tapes
            if used[j]:
                continue
            _, cj, dj, wj = pieces[j]
            if abs(float(d @ dj)) > cos_tol and _dist_to_line(cj, c, d) < max(4.0, 1.5 * wj):
                used[j] = True
                group.append(pieces[j][0])
                c, d, _, _ = fit_line(np.vstack(group))
        cand = _profile(np.vstack(group), dark, bright, thresh)
        if (cand is not None and cand["length"] >= MIN_LENGTH_FRAC * math.hypot(ww, hh)
                and cand["darkness"] >= MIN_LINE_DARK * dark_thresh
                and not (reject_cut and cand["edgeCut"] > MAX_EDGE_CUT)):
            cands.append(cand)
    found["cands"] = sorted(cands, key=lambda cd: -_score(cd))
    return found


def _to_full(pt: np.ndarray, scale: float) -> np.ndarray:
    """Work px -> JPEG px (pixel centres line up)."""
    return (pt + 0.5) / scale - 0.5


def _pick_pass(fine: dict, coarse: dict, w: int) -> dict:
    """The fine pass, unless only the coarse one sees the line or the line is too wide for the fine one."""
    if not coarse["cands"]:
        return fine
    if not fine["cands"]:
        return coarse
    cb, cs = coarse["cands"][0], coarse["scale"]
    if cb["width"] / cs < WIDE_LINE_FRAC * w:
        return fine
    # a wide line: the fine pass found its edges - unless its line lies elsewhere (a separate, thin line)
    a, b = _to_full(cb["near"], cs), _to_full(cb["far"], cs)
    d = (b - a) / max(float(np.linalg.norm(b - a)), 1e-9)
    fb, fs = fine["cands"][0], fine["scale"]
    reach = cb["width"] / cs / 2 + 0.02 * w
    inside = all(_dist_to_line(_to_full(p, fs), a, d) <= reach for p in (fb["near"], fb["far"]))
    return coarse if inside else fine


def _score(cd: dict) -> float:
    return cd["length"] * cd["darkness"]


def detect_line(bgr: np.ndarray, params: dict) -> dict:
    """Result fields for mode "line": {"refY", "line": null | {...}} (+ "mask" when asked for)."""
    p = line_params(params)
    h, w = bgr.shape[:2]
    ref_y = p["refRow"] * h
    result: dict = {"refY": round1(ref_y), "line": None}
    # both passes start from one downscaled copy (resizing the full frame twice costs more than a pass)
    work_w = min(PASSES[0][0], w)
    small = cv2.resize(bgr, (work_w, max(1, round(h * work_w / w))), interpolation=cv2.INTER_AREA) \
        if work_w != w else bgr
    fine = _find_lines(small, p["darkThresh"], *PASSES[0], reject_cut=False)
    coarse = _find_lines(small, p["darkThresh"], *PASSES[1], reject_cut=True)
    for one_pass in (fine, coarse):
        one_pass["scale"] *= work_w / w  # work px per JPEG px
    found = _pick_pass(fine, coarse, w)
    if p["mask"]:
        result["mask"] = mask_data_url(found["mask"])
    cands, scale, (ww, hh) = found["cands"], found["scale"], found["size"]
    if not cands:
        return result

    best = cands[0]
    # confidence: long and clearly dark is good; a second, similar line in view makes it a guess
    length_score = min(1.0, best["length"] / (0.4 * math.hypot(ww, hh)))
    contrast_score = min(1.0, best["darkness"] / (2 * MIN_LINE_DARK * p["darkThresh"]))
    conf = (0.6 * length_score + 0.4 * contrast_score) * (0.5 + 0.5 * min(1.0, best["coverage"]))
    if len(cands) > 1 and _score(cands[1]) > 0.5 * _score(best):
        conf *= 0.6

    # the axis may poke a few px out of the image where the line leaves it at a slant
    p0, p1 = _clip_segment(_to_full(best["near"], scale), _to_full(best["far"], scale), w, h)
    dx, dy = p1 - p0
    angle = math.degrees(math.atan2(dx, -dy))  # 0 = straight up the image, + = far end leans right
    x_ref = p0[0] + (ref_y - p0[1]) * dx / dy if abs(dy) > 1e-6 else (p0[0] + p1[0]) / 2
    offset = min(2.0, max(-2.0, (x_ref - w / 2) / (w / 2)))
    tapes = sorted((_to_full(tp, scale) for tp in best["tapes"]), key=lambda tp: -tp[1])  # bottom -> top
    result["line"] = {
        "p0": round_point(p0),
        "p1": round_point(p1),
        "angleDeg": round1(angle),
        "offset": round(float(offset), 3) + 0.0,
        "widthPx": round1(best["width"] / scale),
        "tapes": round_points(tapes),
        "confidence": round(min(1.0, max(0.0, float(conf))), 2) + 0.0,
    }
    return result
