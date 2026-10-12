import cv2
import numpy as np
import pytest

from sim.pole_autopilot import run
from sim.pole_sim import BALL_D, PoleSim
from vision.docking import RovConfig
from sim.pool_sim import camera_pose
from vision.pole_detector import ColorRange, PoleDetector, range_from_click
from vision.pole_guidance import PoleAssistant, PoleGuideConfig, compute_guidance, measure, parse_order


def sim_at(color, dist, side, height, yaw=0.0, tilt=30, seed=3):
    """Camera `dist` m in front of the pole (horizontal), `side` m to its right, ROV centre at `height`."""
    rov = RovConfig(cam_tilt_deg=tilt)
    sim = PoleSim(rov=rov, seed=seed, caustics=0.3)
    p = sim.pole(color)
    sim.set_pose((p.xy[0] + side, p.xy[1] - dist - rov.length / 2, height), yaw)
    return sim


# ---------- order and colour ranges ----------

def test_parse_order():
    assert parse_order("R-B-Y") == ["red", "blue", "yellow"]
    assert parse_order("ybr") == ["yellow", "blue", "red"]
    for bad in ("R-R-Y", "R-B", "R-B-G", ""):
        with pytest.raises(ValueError):
            parse_order(bad)


def test_red_hue_range_wraps_around_zero():
    hsv = np.array([[[2, 200, 200], [176, 200, 200], [90, 200, 200], [5, 20, 200]]], np.uint8)
    assert ColorRange(170, 10, 80, 40).mask(hsv).tolist() == [[1, 1, 0, 0]]  # last one: not saturated


def test_click_calibration_range_contains_the_clicked_colour():
    for h in (3, 60, 115, 177):
        r = ColorRange.around((h, 180, 150))
        assert r.mask(np.array([[[h, 180, 150], [h, 120, 90]]], np.uint8)).all()  # also the darker side


@pytest.mark.parametrize("color", ["red", "yellow", "blue"])
def test_click_on_a_pole_calibrates_without_grabbing_the_pool(color):
    sim = sim_at(color, 1.2, 0.0, 0.75)
    frame = sim.render()
    c, Rwc = camera_pose(sim.state, sim.rov)
    (u, v), = sim.camera.project((Rwc @ (np.r_[sim.pole(color).xy, 0.4] - c))[None])
    det = PoleDetector()
    det.ranges[color] = range_from_click(frame, int(u), int(v))
    mask = det.ranges[color].mask(cv2.cvtColor(frame, cv2.COLOR_BGR2HSV))
    assert mask.mean() < 0.05  # the blue pool floor must not pass as a blue pole
    assert color in det.detect(frame).poles


# ---------- detection + measurement vs simulator truth ----------

@pytest.mark.parametrize("tilt", [0, 30])
@pytest.mark.parametrize("color,dist,side,height", [("blue", 1.5, 0.2, 0.95), ("yellow", 1.0, -0.15, 0.8),
                                                    ("red", 0.8, 0.1, 0.75)])
def test_pole_found_and_measured(tilt, color, dist, side, height):
    sim = sim_at(color, dist, side, height, tilt=tilt)
    det = PoleDetector().detect(sim.render())
    assert color in det.poles
    m = measure(det.poles[color], sim.camera, tilt, PoleGuideConfig())
    bearing, true_dist, ball_dz = sim.truth(color)
    assert m.bearing_deg == pytest.approx(bearing, abs=1.0)
    assert m.dist_m == pytest.approx(true_dist, rel=0.15)
    assert m.top_dz_m + BALL_D / 2 == pytest.approx(ball_dz, abs=0.05)
    pole = det.poles[color]
    assert pole.ball is not None or not pole.ball_checked  # never "no ball" while it is there


def test_missing_ball_is_noticed():
    sim = sim_at("blue", 1.2, 0.0, 0.9)
    sim.pole("blue").ball_z = BALL_D / 2  # knocked off
    pole = PoleDetector().detect(sim.render()).poles["blue"]
    assert pole.ball_checked and pole.ball is None


# ---------- guidance ----------

def test_guidance_turns_towards_the_pole_and_keeps_the_ball_in_view():
    sim = sim_at("blue", 2.0, 0.5, 0.6, tilt=30)  # pole to the left, ROV low
    rov = sim.rov
    assistant = PoleAssistant(rov, sim.camera, order=["blue", "red", "yellow"])
    view = assistant.update(PoleDetector().detect(sim.render()), 0.0)
    cmds = " | ".join(view.guidance.commands) if view.guidance else view.advice
    assert "TURN LEFT" in cmds
    assert "UP" in cmds  # tilted camera: far away the ROV must stay above the ball to keep it in view


def test_other_pole_in_the_way_is_reported():
    sim = sim_at("blue", 1.5, 0.0, 0.9)
    det = PoleDetector().detect(sim.render())
    cfg = PoleGuideConfig()
    target = measure(det.poles["blue"], sim.camera, 30, cfg)
    blocker = measure(det.poles["blue"], sim.camera, 30, cfg)
    blocker.color, blocker.xz = "red", target.xz * 0.5 + [0.05, 0.0]  # half way, slightly right of the path
    g = compute_guidance(target, [blocker], sim.camera, sim.rov, cfg)
    assert g.warning and "RED" in g.warning and "LEFT" in g.warning
    assert any(c.startswith("TURN LEFT") for c in g.commands)


def test_progress_follows_the_order():
    a = PoleAssistant(RovConfig(), PoleSim(width=64, height=36, seed=0).camera, order=parse_order("Y-R-B"))
    assert a.target == "yellow"
    assert a.mark_hit() == "red"
    a.undo()
    assert a.target == "yellow"


# ---------- end to end: a bot obeying the screen ----------

@pytest.mark.parametrize("seed", [0, 3])
def test_autopilot_hits_all_poles_in_order(seed):
    res = run(seed, tilt=30)
    assert res.points == 50, res
    assert res.confirmed == res.order
