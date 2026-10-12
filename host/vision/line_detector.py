"""Find the dark line (black pipe) on the lighter pool floor, and the tape bands that interrupt it.

Idea: "dark compared to the floor around it", not "black". Underwater a black pipe turns dark blue-green and
the light level changes along the pool, so a fixed colour threshold breaks. A morphological closing with a
kernel wider than the line paints the line over with the surrounding floor colour; closing minus image =
how much darker each pixel is than its neighbourhood (black-hat). Tapes show up as gaps in that dark line,
whatever their colour.
"""
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class LineConfig:
    dark_thresh: int = 25  # minimum "darker than the floor" (0-255) - lower in murky water ([ / ] keys)
    rel_thresh: float = 0.45  # ...and at least this fraction of the darkest line-like pixels in the frame
    work_width: int = 480  # detection runs on a downscaled copy (speed)
    bg_kernel_frac: float = 0.12  # closing kernel, fraction of work width: must be wider than the line
    min_length_frac: float = 0.03  # shortest line reported, fraction of the work image diagonal (short ones are
                                   # only trusted when they continue the line we already follow)
    min_elongation: float = 3.0
    max_gap_frac: float = 0.25  # a gap (tape) longer than this fraction of the visible line is not a tape
    tape_max_dark: float = 0.4  # inside a tape the darkness must drop below this fraction of the line's darkness
    smooth: float = 1.5  # px (work size) of noise blur; raise in noisy/dark water, at the cost of far tapes


@dataclass
class LineCandidate:
    """One straight dark line, in full-frame pixels. p0 is the end nearer the bottom of the image (the ROV)."""
    p0: np.ndarray
    p1: np.ndarray
    centers: np.ndarray  # Nx2 points on the line centre (only where it is dark)
    widths: np.ndarray  # N, line width in px at those points
    tapes: list[np.ndarray] = field(default_factory=list)  # centre px of each gap between dark pieces
    near_end_inside: bool = False  # the line really ends inside the image (not cut by the image border)
    far_end_inside: bool = False
    darkness: float = 0.0

    @property
    def direction(self) -> np.ndarray:
        d = self.p1 - self.p0
        return d / max(np.linalg.norm(d), 1e-9)

    @property
    def length(self) -> float:
        return float(np.linalg.norm(self.p1 - self.p0))


@dataclass
class LineDetection:
    candidates: list[LineCandidate]  # best first
    mask: np.ndarray  # work-size debug mask (what the detector considers "dark")
    threshold: float = 0.0


class LineDetector:
    def __init__(self, cfg: LineConfig | None = None):
        self.cfg = cfg or LineConfig()

    def darkness(self, frame: np.ndarray) -> tuple[np.ndarray, float]:
        """Work-size black-hat image and the scale factor work/full."""
        h, w = frame.shape[:2]
        scale = self.cfg.work_width / w
        small = cv2.resize(frame, (self.cfg.work_width, round(h * scale)), interpolation=cv2.INTER_AREA)
        v = small.max(axis=2)  # brightest channel: blue floor stays bright, a black pipe stays dark in every channel
        v = cv2.GaussianBlur(v, (0, 0), self.cfg.smooth)  # sensor noise is per pixel, the line is several px wide
        k = int(self.cfg.work_width * self.cfg.bg_kernel_frac) | 1
        bg = cv2.morphologyEx(v, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
        return cv2.subtract(bg, v), scale

    def detect(self, frame: np.ndarray) -> LineDetection:
        cfg = self.cfg
        dark, scale = self.darkness(frame)
        hh, ww = dark.shape
        peak = float(np.percentile(dark, 99.7))
        thresh = max(cfg.dark_thresh, cfg.rel_thresh * peak)
        mask = (dark > thresh).astype(np.uint8)

        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        order = np.argsort(-stats[1:, cv2.CC_STAT_AREA])[:20] + 1
        pieces = []  # (points Nx2 float, centre, direction, length, width)
        for i in order:
            if stats[i, cv2.CC_STAT_AREA] < 6:
                break
            ys, xs = np.nonzero(labels == i)
            pts = np.c_[xs, ys].astype(np.float64)
            c, d, length, width = fit_line(pts)
            if length >= 4 and length / max(width, 1.0) >= cfg.min_elongation:
                pieces.append((pts, c, d, length, width))

        min_len = cfg.min_length_frac * np.hypot(ww, hh)
        used = [False] * len(pieces)
        cands = []
        for i, (pts, c, d, length, width) in enumerate(pieces):
            if used[i]:
                continue
            used[i] = True
            group = [pts]
            for j in range(i + 1, len(pieces)):  # collinear pieces = one line broken by tapes
                if used[j]:
                    continue
                _, cj, dj, _, wj = pieces[j]
                if abs(float(d @ dj)) > np.cos(np.radians(12)) and _dist_to_line(cj, c, d) < max(4.0, 1.5 * wj):
                    used[j] = True
                    group.append(pieces[j][0])
                    c, d, _, _ = fit_line(np.vstack(group))
            cand = self._profile(np.vstack(group), dark, thresh, (ww, hh))
            if cand is not None and cand.length >= min_len:
                cands.append(cand)

        for cand in cands:  # back to full-frame pixels
            for name in ("p0", "p1", "centers", "widths"):
                setattr(cand, name, getattr(cand, name) / scale)
            cand.tapes = [t / scale for t in cand.tapes]
        cands.sort(key=lambda cd: -cd.length * cd.darkness)
        return LineDetection(cands, mask * 255, thresh)

    def _profile(self, pts, dark, thresh, size) -> LineCandidate | None:
        """Walk along the fitted line and read where it is dark (line) and where it is not (tapes, ends)."""
        c, d, _, width = fit_line(pts)
        if d[1] < 0:
            d = -d  # point down the image: t grows towards the ROV
        nrm = np.array([-d[1], d[0]])
        t = (pts - c) @ d
        t0, t1 = float(t.min()), float(t.max())
        pad = max(10.0, 0.3 * (t1 - t0))  # look past the ends: short end pieces behind a tape are too stubby
        ts = np.arange(t0 - pad, t1 + pad + 1.0)  # to be found as line pieces on their own
        half = max(3.0, 1.5 * width)
        ss = np.arange(-half, half + 1.0)
        grid = c + ts[:, None, None] * d + ss[None, :, None] * nrm  # len(ts) x len(ss) x 2
        mx, my = grid[..., 0].astype(np.float32), grid[..., 1].astype(np.float32)
        strip_dark = cv2.remap(dark, mx, my, cv2.INTER_LINEAR, borderValue=0).astype(np.float32)
        is_dark = strip_dark.max(axis=1) > thresh * 0.8
        runs = _runs(is_dark)
        runs = [r for r in runs if r[1] - r[0] >= 2]
        if not runs:
            return None
        total = runs[-1][1] - runs[0][0]
        profile = strip_dark.max(axis=1)
        line_dark = float(np.median(profile[np.concatenate([np.arange(a, b) for a, b in runs])]))
        tapes = []
        for (_, a_end), (b_start, _) in zip(runs[:-1], runs[1:]):
            gap = b_start - a_end
            # a tape is clearly NOT dark (floor level or brighter); noise or murk only makes the line a bit lighter
            if (gap <= max(3, self.cfg.max_gap_frac * total)
                    and profile[a_end:b_start].min() < self.cfg.tape_max_dark * line_dark):
                tapes.append(c + d * ts[(a_end + b_start) // 2])
        keep = np.zeros(len(ts), bool)
        for a, b in runs:
            keep[a:b] = True
        # width = where it is at least half as dark as the line centre (independent of the global threshold);
        # centre = middle of those pixels
        rows = strip_dark[keep]
        weights = (rows >= 0.5 * rows.max(axis=1, keepdims=True)).astype(np.float64)
        counts = weights.sum(axis=1)
        offs = (weights @ ss) / np.maximum(counts, 1)
        centers = c + ts[keep, None] * d + offs[:, None] * nrm
        far = c + d * ts[runs[0][0]]  # small t = top of the image = far from the ROV
        near = c + d * ts[runs[-1][1] - 1]
        w, h = size
        inside = lambda p: 3 < p[0] < w - 4 and 3 < p[1] < h - 4  # noqa: E731
        return LineCandidate(p0=near, p1=far, centers=centers, widths=counts, tapes=tapes,
                             near_end_inside=inside(near), far_end_inside=inside(far),
                             darkness=float(strip_dark.max(axis=1)[keep].mean()))


def fit_line(pts: np.ndarray):
    """Centre, unit main direction, length and width of a point cloud (uniform bar: L = sqrt(12 var))."""
    c = pts.mean(axis=0)
    cov = np.cov((pts - c).T) if len(pts) > 1 else np.eye(2)
    vals, vecs = np.linalg.eigh(cov)
    return c, vecs[:, 1], float(np.sqrt(12 * max(vals[1], 0))), float(np.sqrt(12 * max(vals[0], 0)))


def _dist_to_line(p, c, d) -> float:
    v = p - c
    return float(abs(v[0] * d[1] - v[1] * d[0]))


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index ranges where flags is True."""
    padded = np.r_[False, flags, False].astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))
