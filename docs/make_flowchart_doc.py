"""Flow chart for the technical documentation: electrical part + coding part on one landscape page.

    python3 docs/make_flowchart_doc.py      # writes docs/diagrams/rov_flow_chart.svg and .png

Hand-placed SVG (no layout engine) so the page is dense and readable when printed; the PNG is
rendered at 2x by Google Chrome in headless mode. Edit the coordinates below to change it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from xml.sax.saxutils import escape

DOCS = Path(__file__).resolve().parent
OUT_SVG = DOCS / "diagrams" / "rov_flow_chart.svg"
OUT_PNG = DOCS / "diagrams" / "rov_flow_chart.png"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H = 1600, 1130

# line colours (also the legend)
RED, BLUE, GREEN, PURPLE, GRAY = "#D93A3A", "#2F6FD0", "#2E9A55", "#7B5BD6", "#5A6270"

# box styles: fill, stroke
SURFACE = ("#EEF2F7", "#8A99AD")
ELECTRONICS = ("#E3EEFC", "#2F6FD0")
ESC = ("#FFF1DC", "#D98A1C")
THRUSTER = ("#E1F5EE", "#1D9E75")
PROCESS = ("#E8F0FE", "#3B6FD8")
DECISION = ("#FFF4D6", "#C9930F")
TERMINAL = ("#DFF3E4", "#2E9A55")
SAFETY = ("#FDECEC", "#D64545")
VISION = ("#F0ECFD", "#6F5BD6")

FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif"
out: list[str] = []


def text(x, y, s, size=15, weight=400, color="#1d2430", anchor="middle"):
    out.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color}" '
               f'text-anchor="{anchor}" dominant-baseline="central">{escape(s)}</text>')


def lines(cx, cy, title, subs=(), title_size=19, sub_size=15):
    """Title + subtitle lines centred around (cx, cy)."""
    rows = [(title, title_size, 700)] + [(s, sub_size, 400) for s in subs]
    step = 22
    y0 = cy - step * (len(rows) - 1) / 2
    for i, (s, size, weight) in enumerate(rows):
        text(cx, y0 + i * step, s, size, weight, "#1d2430" if weight == 700 else "#3d4756")


def box(x, y, w, h, style, title, subs=(), rx=10, **kw):
    fill, stroke = style
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
               f'stroke="{stroke}" stroke-width="2"/>')
    lines(x + w / 2, y + h / 2, title, subs, **kw)


def oval(cx, cy, w, h, style, title, subs=()):
    box(cx - w / 2, cy - h / 2, w, h, style, title, subs, rx=h / 2)


def diamond(cx, cy, hw, hh, style, title, subs=()):
    fill, stroke = style
    out.append(f'<polygon points="{cx},{cy - hh} {cx + hw},{cy} {cx},{cy + hh} {cx - hw},{cy}" '
               f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    lines(cx, cy, title, subs, title_size=18)


def path(points, color, width=3, dash=False, arrow=True, halo=False):
    d = "M " + " L ".join(f"{x},{y}" for x, y in points)
    if halo:  # white underlay: this wire visibly crosses OVER another one
        out.append(f'<path d="{d}" fill="none" stroke="#ffffff" stroke-width="{width + 8}"/>')
    dash_attr = ' stroke-dasharray="9 7"' if dash else ""
    marker = f' marker-end="url(#a{color[1:]})"' if arrow else ""
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
               f'stroke-linejoin="round"{dash_attr}{marker}/>')


def pill(cx, cy, s, color, size=14):
    w = len(s) * size * 0.56 + 22
    out.append(f'<rect x="{cx - w / 2}" y="{cy - 13}" width="{w}" height="26" rx="13" fill="#ffffff" '
               f'stroke="{color}" stroke-width="1.5"/>')
    text(cx, cy, s, size, 600, color)


def zone(x, y, w, h, label, bottom=False):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="none" stroke="#9aa6b6" '
               f'stroke-width="1.5" stroke-dasharray="7 6"/>')
    text(x + 14, y + h - 18 if bottom else y + 20, label, 13, 700, "#6b7686", "start")


def build() -> str:
    # ---------------- header + legend ----------------
    text(40, 52, "ROV control system: flow chart", 30, 700, "#111827", "start")
    legend = [("12 V power", RED, False), ("PWM signal", BLUE, False), ("USB data", GREEN, False),
              ("video", PURPLE, False), ("Wi-Fi", GREEN, True)]
    x = 870
    for label, color, dash in legend:
        path([(x, 52), (x + 34, 52)], color, 4, dash=dash, arrow=False)
        text(x + 44, 52, label, 16, 500, "#1d2430", "start")
        x += 52 + len(label) * 9 + 30

    # ---------------- panels ----------------
    for px, pw, title in ((30, 770, "ELECTRICAL PART"), (820, 750, "CODING PART")):
        out.append(f'<rect x="{px}" y="95" width="{pw}" height="1015" rx="16" fill="#FAFBFD" '
                   f'stroke="#cfd7e3" stroke-width="2"/>')
        text(px + 22, 125, title, 22, 800, "#111827", "start")

    # ================= ELECTRICAL =================
    zone(50, 150, 720, 180, "POOL SIDE (SURFACE)")
    zone(50, 520, 720, 570, "ROV  (WATERPROOF BOX + FRAME)", bottom=True)  # top edge is full of wires

    box(66, 185, 210, 125, SURFACE, "Power box", ["organiser, 12 V DC", "fuse, kill switch", "V / A meter"])
    box(296, 185, 170, 125, SURFACE, "Wi-Fi tower", ["Mission 1", "2.4 GHz, HTTP"])
    box(486, 185, 268, 125, SURFACE, "Laptop", ["ground station", "keyboard, Chrome GUI", "Python bridge, vision"])

    box(296, 560, 250, 90, ELECTRONICS, "ESP32-S3 DevKitC-1", ["firmware: PWM, watchdog"])
    box(586, 560, 168, 90, ELECTRONICS, "USB camera", ["720p"])

    esc_x = [66, 298, 530]  # width 214: centres 173, 405, 637
    for x0, name, pin in zip(esc_x, ("left", "right", "vertical"), (1, 40, 42)):
        box(x0, 760, 214, 90, ESC, f"ESC {name}", [f"signal: GPIO {pin}"])
        box(x0, 950, 214, 90, THRUSTER, f"Thruster {name}", ["brushless"])
        path([(x0 + 107, 850), (x0 + 107, 946)], GRAY)
        pill(x0 + 107, 898, "3-phase", GRAY)

    # power: box -> left ESC, bus at y 725 -> middle and right ESC
    path([(138, 310), (138, 756)], RED)
    path([(138, 725), (602, 725), (602, 756)], RED)
    path([(370, 725), (370, 756)], RED)
    # PWM signal + GND: ESP32 -> middle ESC, bus at y 690 -> left and right ESC (crosses the 12 V bus)
    path([(440, 650), (440, 756)], BLUE, halo=True)
    path([(440, 690), (208, 690), (208, 756)], BLUE, halo=True)
    path([(440, 690), (672, 690), (672, 756)], BLUE, halo=True)
    pill(440, 670, "PWM 50 Hz + GND", BLUE)
    # tether
    path([(520, 310), (520, 556)], GREEN)               # laptop -> ESP32
    path([(700, 560), (700, 314)], PURPLE)              # camera -> laptop
    path([(340, 560), (340, 314)], GREEN, dash=True)    # ESP32 -> tower
    pill(138, 420, "12 V DC, XT60", RED)
    pill(340, 420, "Wi-Fi 2.4 GHz", GREEN)
    pill(520, 465, "USB serial + 5 V", GREEN)
    pill(700, 420, "USB video", PURPLE)
    text(410, 375, "tether, 5 m", 14, 600, "#6b7686")

    # ================= CODING =================
    cx = 1030  # main column (x 850..1210)
    oval(cx, 180, 170, 46, TERMINAL, "Start")
    box(850, 230, 360, 76, PROCESS, "ESP32 boots", ["thrusters neutral, 4 s ESC arming"])
    box(850, 336, 360, 76, PROCESS, "Laptop: start bridge", ["open the GUI in Chrome"])
    diamond(cx, 497, 130, 55, DECISION, "ARM pressed?")
    box(850, 582, 360, 72, PROCESS, "Read keys", ["W/S surge, A/D yaw, R/F heave"])
    box(850, 682, 360, 92, PROCESS, "Mixer", ["left = surge + yaw, right = surge - yaw",
                                               "vert = heave, speed limit, ramp"])
    box(850, 802, 360, 72, PROCESS, "Send  D left right vert", ["USB serial, 20 times per second"])
    diamond(cx, 945, 140, 50, DECISION, "ESP32: valid", ["command?"])
    box(850, 1022, 360, 72, PROCESS, "Clamp ±150 µs, ESC trim", ["PWM 50 Hz to the 3 ESCs"])

    for y1, y2 in ((203, 226), (306, 332), (412, 438), (552, 578), (654, 678), (774, 798), (874, 891),
                   (995, 1018)):
        path([(cx, y1), (cx, y2)], GRAY)
    text(cx + 18, 566, "yes", 15, 700, GREEN, "start")
    text(cx + 18, 1007, "yes", 15, 700, GREEN, "start")
    # loop back: every tick reads the keys again
    path([(850, 838), (836, 838), (836, 618), (846, 618)], GRAY, width=2, dash=True)

    # side column (x 1250..1550)
    zone(1240, 150, 320, 262, "CAMERA MISSIONS (LAPTOP)")
    box(1258, 182, 284, 56, VISION, "Camera frame", ["up to 15 per second"], title_size=17, sub_size=14)
    box(1258, 262, 284, 56, VISION, "Detect", ["AprilTags, line, pole colours"], title_size=17, sub_size=14)
    box(1258, 342, 284, 56, VISION, "Hints on the video", ["the pilot steers"], title_size=17, sub_size=14)
    path([(1400, 238), (1400, 258)], PURPLE, width=2)
    path([(1400, 318), (1400, 338)], PURPLE, width=2)

    box(1258, 462, 284, 70, PROCESS, "Send S (stop)", ["20 times per second"])
    path([(1160, 497), (1254, 497)], GRAY)
    text(1205, 482, "no", 15, 700, RED)

    out.append('<rect x="1258" y="570" width="284" height="304" rx="10" fill="#FDECEC" stroke="#D64545" '
               'stroke-width="2"/>')
    text(1400, 596, "Safety, always on", 19, 700, "#8f1d1d")
    safety = [("Watchdog:", "no command for 500 ms"), ("", "→ all thrusters stop"),
              ("E-STOP:", "Esc key or button"), ("", "→ disarm, send S"),
              ("Link lost:", "bridge, USB or ESP32"), ("", "→ disarm at once"),
              ("Limit:", "±150 µs, in firmware")]
    for i, (head, rest) in enumerate(safety):
        y = 632 + i * 33
        if head:
            text(1274, y, head, 15, 700, "#8f1d1d", "start")
        text(1360, y, rest, 15, 400, "#3d1717", "start")

    box(1258, 912, 284, 66, PROCESS, "Ignore the line", ["never half-applied"])
    path([(1170, 945), (1254, 945)], GRAY)
    text(1212, 930, "no", 15, 700, RED)
    oval(1400, 1058, 284, 64, TERMINAL, "Thrusters move")
    path([(1210, 1058), (1254, 1058)], GRAY)

    defs = "".join(
        f'<marker id="a{c[1:]}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5" markerHeight="5" '
        f'orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 z" fill="{c}"/></marker>'
        for c in (RED, BLUE, GREEN, PURPLE, GRAY))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
            f'font-family="{FONT}"><defs>{defs}</defs><rect width="{W}" height="{H}" fill="#ffffff"/>'
            + "".join(out) + "</svg>")


def main() -> None:
    OUT_SVG.parent.mkdir(exist_ok=True)
    OUT_SVG.write_text(build(), encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    f"--window-size={W},{H}", "--force-device-scale-factor=2",
                    f"--screenshot={OUT_PNG}", OUT_SVG.as_uri()],
                   check=True, capture_output=True, timeout=120)
    print(f"{OUT_SVG.relative_to(DOCS)}, {OUT_PNG.relative_to(DOCS)}")


if __name__ == "__main__":
    main()
