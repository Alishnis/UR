"""Physics-based underwater camera frames of the Mission 5 poles, for testing the colour detector.

Why: water does not just "tint" the picture. It absorbs every wavelength at its own rate (red ~35 times
faster than blue), and it scatters light back into the camera (the blue-green veil that grows with the
distance). A red pole therefore gets darker AND its colour slides towards the water colour as the robot
backs off, and the camera's auto white balance then pulls everything around again. Painting "red, but
a bit darker" (vision_synth.py) misses all of that, so this module renders the scene spectrally:

    camera signal  =  sum over wavelength of  sensor(l) * radiance(l)
    radiance(l)    =  light(l, depth) * paint(l) * shade * exp(-c(l) * z)       direct light from the pole
                   +  veil(l, depth) * (1 - exp(-c(l) * z))                     backscatter in front of it

(the simplified Jaffe-McGlamery model, as used by Akkaynak & Treibitz, "A Revised Underwater Image
Formation Model", CVPR 2018). z = camera-to-pole distance, depth = how deep the pole is, so how much
water the daylight / pool lights crossed first. c = a + b: absorption of pure water (Pope & Fry 1997)
plus scattering by what is floating in the pool (the `turbidity` knob).

Then the camera: auto exposure, white balance (auto like a webcam, or locked at the surface), sRGB gamma,
sensor noise, lens blur and JPEG. All numbers are textbook values or deliberately pessimistic guesses;
the point is to be WORSE than the real pool, so a detector that passes here has margin there.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import cv2
import numpy as np

# ---------- spectra, 400..700 nm in 10 nm steps ----------

WL = np.arange(400, 701, 10, dtype=np.float64)

# Absorption of pure water, 1/m (Pope & Fry 1997, Applied Optics 36(33)). Red (650 nm) 0.34/m,
# blue (450 nm) 0.009/m: after 3 m of water 36 % of the red is left and 97 % of the blue.
_POPE_FRY = {
    400: 0.00663, 410: 0.00473, 420: 0.00454, 430: 0.00495, 440: 0.00635, 450: 0.00922, 460: 0.00979,
    470: 0.0106, 480: 0.0127, 490: 0.0150, 500: 0.0204, 510: 0.0325, 520: 0.0409, 530: 0.0434,
    540: 0.0474, 550: 0.0565, 560: 0.0619, 570: 0.0695, 580: 0.0896, 590: 0.1351, 600: 0.2224,
    610: 0.2644, 620: 0.2755, 630: 0.2916, 640: 0.3108, 650: 0.3400, 660: 0.4100, 670: 0.4390,
    680: 0.4650, 690: 0.5160, 700: 0.6240,
}
A_WATER = np.array([_POPE_FRY[int(w)] for w in WL])


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def _gauss(mu: float, sigma: float) -> np.ndarray:
    return np.exp(-0.5 * ((WL - mu) / sigma) ** 2)


# Diffuse reflectance of glossy plastic / paint (typical shapes of red, yellow and blue pigments).
PAINT = {
    "red": 0.05 + 0.65 * _sigmoid((WL - 605) / 9),  # reflects only above ~600 nm: exactly what water eats
    "yellow": 0.06 + 0.76 * _sigmoid((WL - 515) / 11),
    "blue": 0.05 + 0.42 * _gauss(465, 35) + 0.06 * _sigmoid((WL - 680) / 10),
    "white": np.full(WL.shape, 0.85),  # golf ball
    # neutral things that may be in the picture (a grey / white PVC pipe, a black weight, the tether):
    # after the water-colour balance they look warm, so they are the test of "nothing else is red"
    "grey": np.full(WL.shape, 0.25),
    "white_pipe": np.full(WL.shape, 0.85),
    "black": np.full(WL.shape, 0.06),
}
NEUTRALS = ("grey", "white_pipe", "black")
POLE_COLORS = ("red", "yellow", "blue")
# pool wall: light blue tiles (half white, half the blue pigment). A wall painted exactly the pole's blue
# would hide the blue pole from ANY colour method; see test_blue_pole_on_same_blue_wall_is_a_known_limit.
WALL_TILE = 0.5 * PAINT["white"] + 0.5 * PAINT["blue"]

# Camera sensor sensitivities (typical CMOS + IR-cut filter: R falls off sharply past ~660 nm).
SENSOR = np.stack([
    _gauss(460, 24),                                             # B
    _gauss(535, 30),                                             # G
    _gauss(600, 26) * _sigmoid((665 - WL) / 8) + 0.05 * _gauss(540, 30),  # R
])  # rows in B, G, R order like OpenCV


def blackbody(kelvin: float) -> np.ndarray:
    """Relative spectral power of a black body (a fair stand-in for daylight / LED / halogen)."""
    lam = WL * 1e-9
    p = 1 / (lam ** 5 * (np.exp(1.4388e-2 / (lam * kelvin)) - 1))
    return p / p.max()


LIGHTS = {"led4000": 4000.0, "daylight": 6500.0, "warm3000": 3000.0}


# ---------- the scene ----------

@dataclass(frozen=True)
class Water:
    turbidity: float = 0.1   # scattering b, 1/m: 0.02 very clear .. 0.1 normal pool .. 0.5 cloudy
    depth: float = 1.0       # m of water the light crossed before reaching the pole (pole mid-depth)
    light: str = "led4000"   # pool lighting, see LIGHTS
    floor_blue: float = 0.5  # 0..1: how much blue pool walls / floor add to the light from the side
    gradient_m: float = 0.0  # water colour changes down the picture: the bottom row looks through this
                             # much more water than the middle (towards the deep floor), the top row
                             # half as much less (towards the bright surface)

    @property
    def c(self) -> np.ndarray:  # beam attenuation, 1/m
        return A_WATER + self.turbidity

    def light_at_depth(self) -> np.ndarray:
        """Light reaching the pole: the lamp spectrum after `depth` m of water (diffuse attenuation
        ~ 1.1 a + b_b), plus light bounced off the blue pool floor (even poorer in red)."""
        e = blackbody(LIGHTS[self.light]) * np.exp(-(1.1 * A_WATER + 0.2 * self.turbidity) * self.depth)
        bounce = e * PAINT["blue"] * np.exp(-A_WATER * 2.0)
        return e + self.floor_blue * bounce

    def veil(self) -> np.ndarray:
        """Radiance of an infinitely deep column of water (backscatter): scattered light, so the more
        the water scatters and the less it absorbs, the brighter; its colour is the water colour."""
        albedo = self.turbidity / (A_WATER + self.turbidity)
        return 0.35 * albedo * self.light_at_depth()


@dataclass(frozen=True)
class Camera:
    w: int = 640
    h: int = 360
    hfov_water_deg: float = 52.0  # 70 deg in air behind a flat port
    wb: str = "auto"              # "auto" (webcam AWB), "locked" (set at the surface), "none"
    awb_limit: float = 2.6        # webcams can only push a channel so far (colour temperature range)
    exposure: float = 0.42        # auto exposure target: mean of the frame (linear 0..1 before gamma)
    noise: float = 0.012          # sensor noise, linear units
    blur: float = 0.8             # lens / focus blur, px
    jpeg: int = 75

    @property
    def f(self) -> float:
        return (self.w / 2) / math.tan(math.radians(self.hfov_water_deg) / 2)


@dataclass(frozen=True)
class PoleSpec:
    color: str
    x_m: float               # sideways offset from the camera axis, m (right +)
    z_m: float               # distance, m
    diameter_m: float = 0.05
    height_m: float = 0.6
    top_m: float = -0.25     # top of the pole relative to the camera height, m (up -)


@dataclass
class PoleTruth:
    color: str
    box: tuple[float, float, float, float]  # x, y, w, h in px
    z_m: float

    @property
    def center(self) -> tuple[float, float]:
        x, y, w, h = self.box
        return x + w / 2, y + h / 2


def _rgb(spectrum: np.ndarray) -> np.ndarray:
    """Spectral radiance -> linear camera signal (B, G, R)."""
    return SENSOR @ spectrum / SENSOR.sum(axis=1)


def white_balance_gains(water: Water, cam: Camera, frame_lin: np.ndarray) -> np.ndarray:
    """Per-channel gains (B, G, R). locked: a white card under the lamps at the SURFACE is grey (what you
    get when the camera was balanced on land or in air before diving). auto: grey world on this frame,
    limited to what a webcam's colour-temperature range allows. none: raw sensor."""
    if cam.wb == "none":
        return np.ones(3)
    if cam.wb == "locked":
        ref = _rgb(blackbody(LIGHTS[water.light]) * PAINT["white"])
    else:
        ref = frame_lin.reshape(-1, 3).mean(axis=0)
    g = ref[1] / np.maximum(ref, 1e-9)
    return np.clip(g, 1 / cam.awb_limit, cam.awb_limit)


def render(poles: list[PoleSpec], water: Water | None = None, cam: Camera | None = None, *,
           seed: int = 0, wall_m: float | None = None) -> tuple[np.ndarray, list[PoleTruth]]:
    """BGR uint8 frame (after JPEG) and where each pole is. wall_m: a blue-tiled pool wall that far
    behind the poles (None = open water)."""
    water = water or Water()
    cam = cam or Camera()
    rng = np.random.default_rng(seed)
    w, h, f = cam.w, cam.h, cam.f
    light = water.light_at_depth()
    c = water.c
    veil = water.veil()
    veil_rgb = _rgb(veil)

    # background: open water (the veil, slightly brighter towards the surface) or a far blue wall
    rows = np.linspace(1.12, 0.88, h)[:, None, None]
    if wall_m is None and water.gradient_m:
        extra = np.linspace(-0.5, 1.0, h) * water.gradient_m  # m of extra water per row
        bg = np.stack([_rgb(veil * np.exp(-1.1 * A_WATER * e)) for e in extra])[:, None, :] * np.ones((1, w, 1))
        bg = bg * rows
    elif wall_m is None:
        bg = np.broadcast_to(veil_rgb, (h, w, 3)) * rows
    else:
        t = np.exp(-c * wall_m)
        wall = _rgb(light * WALL_TILE * t) + _rgb(veil * (1 - t))
        bg = np.broadcast_to(wall, (h, w, 3)) * rows
    img = np.array(bg, dtype=np.float64)

    truths: list[PoleTruth] = []
    ss = 4  # supersampling across the pole width for smooth, correctly blended edges
    for p in sorted(poles, key=lambda p: -p.z_m):  # far first: near poles cover far ones
        t = np.exp(-c * p.z_m)
        direct = _rgb(light * PAINT[p.color] * t)
        front = _rgb(veil * (1 - t))
        cx = w / 2 + f * p.x_m / p.z_m
        half = f * p.diameter_m / 2 / p.z_m
        y0 = h / 2 + f * p.top_m / p.z_m
        y1 = y0 + f * p.height_m / p.z_m
        truths.append(PoleTruth(p.color, (cx - half, y0, 2 * half, y1 - y0), p.z_m))
        xa, xb = int(math.floor(cx - half)), int(math.ceil(cx + half))
        ya, yb = max(0, int(math.floor(y0))), min(h, int(math.ceil(y1)))
        if xb <= 0 or xa >= w or yb <= ya:
            continue
        xs = (np.arange(xa * ss, xb * ss) + 0.5) / ss
        u = (xs - cx) / max(half, 1e-9)  # -1..1 across the pole
        inside = np.abs(u) <= 1
        # cylinder lit from above and from the side (lamps, bright surface): Lambert across the width
        shade = np.where(inside, 0.55 + 0.45 * np.sqrt(np.clip(1 - u ** 2, 0, 1)), 0)
        cov = inside.reshape(-1, ss).mean(axis=1)                 # coverage of each pixel column
        sh = (shade.reshape(-1, ss).sum(axis=1) / np.maximum(inside.reshape(-1, ss).sum(axis=1), 1))
        col = sh[:, None] * direct + front                          # pole colour per pixel column
        lo, hi = max(xa, 0), min(xb, w)
        sl = slice(lo - xa, hi - xa)
        ys = np.arange(ya, yb)
        vcov = np.clip(np.minimum(ys + 1, y1) - np.maximum(ys, y0), 0, 1)[:, None, None]
        a = cov[sl][None, :, None] * vcov
        img[ya:yb, lo:hi] = img[ya:yb, lo:hi] * (1 - a) + col[sl][None, :, :] * a
        # the golf ball on top
        r = max(2.0, f * 0.0214 / p.z_m)
        ball = _rgb(light * PAINT["white"] * t) * 0.9 + front
        cv2.circle(img, (int(round(cx)), int(round(y0 - r))), int(round(r)), ball.tolist(), -1, cv2.LINE_AA)

    # camera: white balance, auto exposure, noise, gamma, blur, JPEG
    img = img * white_balance_gains(water, cam, img)[None, None, :]
    img = img * (cam.exposure / max(img.mean(), 1e-9))
    img = img + rng.normal(0, cam.noise, img.shape) * np.sqrt(np.clip(img, 0, 1) + 0.05)
    img = np.clip(img, 0, 1)
    srgb = np.where(img <= 0.0031308, 12.92 * img, 1.055 * img ** (1 / 2.4) - 0.055)
    out = (srgb * 255 + 0.5).astype(np.uint8)
    if cam.blur:
        out = cv2.GaussianBlur(out, (0, 0), cam.blur)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, cam.jpeg])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR), truths


def three_poles(z_m: float, spread_m: float | None = None, **kw) -> list[PoleSpec]:
    """Red, yellow and blue side by side at the same distance (spread so they stay in the picture)."""
    s = spread_m if spread_m is not None else min(0.35, 0.28 * z_m)
    return [PoleSpec("red", -s, z_m, **kw), PoleSpec("yellow", 0.0, z_m, **kw), PoleSpec("blue", s, z_m, **kw)]


def with_(obj, **kw):
    return replace(obj, **kw)
