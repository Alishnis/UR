import math

import numpy as np
import pytest

from sim.line_autopilot import STARTS, run
from sim.line_sim import TAPES, LineSim, pose_along
from vision.camera_model import CameraModel
from vision.docking import RovConfig
from vision.floor_geometry import FloorProjector
from vision.line_detector import LineDetector
from vision.line_follow import LineAssistant, TapeCounter


def view_at(along, offset, height, rel_yaw, tilt=30):
    rov = RovConfig(cam_tilt_deg=tilt)
    sim = LineSim(rov=rov, caustics=0.3, seed=0)
    sim.set_pose(*pose_along(along, offset, height, rel_yaw))
    assistant = LineAssistant(rov, sim.camera)
    det = LineDetector().detect(sim.render())
    return assistant.update(det, 0.0), sim


# ---------- geometry ----------

def test_floor_projection_round_trip_and_blind_zone():
    cam = CameraModel.from_hfov(1280, 720, 70)
    proj = FloorProjector(cam, 30)
    px = np.array([[640, 700], [200, 500], [1100, 450]])
    np.testing.assert_allclose(proj.to_image(proj.to_floor(px)), px, atol=1e-6)
    assert proj.to_floor([[640, 0]])[0, 1] > 0  # top row still sees the floor at 30 deg tilt
    # the bottom row sees the floor at 1 / tan(tilt + vfov/2) camera heights ahead
    expected = 1 / math.tan(math.radians(30 + cam.vfov_deg / 2))
    assert proj.nearest_visible() == pytest.approx(expected, rel=0.01)
    assert np.isnan(FloorProjector(cam, 0).to_floor([[640, 100]])).all()  # above the horizon


# ---------- detection + guidance vs simulator truth ----------

@pytest.mark.parametrize("tilt,pose", [(30, (-0.3, 0.2, 0.6, 10)), (30, (0.5, -0.1, 0.5, -15)),
                                       (45, (0.2, 0.1, 0.6, 5)), (20, (-0.5, -0.15, 0.7, -8))])
def test_heading_offset_and_height_match_truth(tilt, pose):
    view, sim = view_at(*pose, tilt=tilt)
    _, offset, heading = sim.truth()
    g = view.guidance
    assert g is not None
    assert g.heading_deg == pytest.approx(heading, abs=1.5)
    assert g.offset_m == pytest.approx(offset, abs=0.03)
    assert view.height_source == "line width"
    assert view.height == pytest.approx(sim.camera_height(), rel=0.15)


def test_tapes_are_found_where_they_are():
    view, sim = view_at(-0.3, 0.0, 0.6, 0)
    along = sim.truth()[0]
    truth = TAPES - along  # m ahead of the ROV centre
    found = sorted(view.guidance.tapes_m)
    assert len(found) == 3  # the START tape is in the blind zone under the nose
    np.testing.assert_allclose(found, truth[1:], rtol=0.12)


def test_line_to_the_right_means_turn_right_and_aligned_means_forward():
    view, _ = view_at(0.2, -0.25, 0.6, 0)  # ROV 25 cm left of the line = line to the right
    assert view.guidance.commands[0].startswith("TURN RIGHT")
    view, _ = view_at(0.2, 0.0, 0.6, 0)
    assert view.guidance.aligned and view.guidance.commands == ["FORWARD"]


def test_tile_grout_is_not_taken_for_the_line():
    view, _ = view_at(3.0, 0.0, 0.6, 0)  # past the end: only tile grout in view
    assert view.candidate is None and view.advice.startswith("SEARCH")


# ---------- tape counter ----------

def test_counter_counts_tapes_leaving_at_the_bottom_while_approaching():
    c = TapeCounter()
    for s in np.arange(1.2, 0.55, -0.03):  # tape comes closer, near edge of the view at 0.6
        c.update([s] if s > 0.6 else [], 0.6)
    for _ in range(5):
        c.update([], 0.6)
    assert c.passed == 1


def test_counter_ignores_rising_and_counts_back_when_reversing():
    c = TapeCounter()
    for near in np.arange(0.6, 1.1, 0.03):  # rising: the near edge moves out past a tape that stays put
        c.update([1.0] if near < 1.0 else [], near)
    for _ in range(5):
        c.update([], 1.1)
    assert c.passed == 0
    c.passed = 1
    for s in np.arange(0.62, 1.0, 0.03):  # reversing: the tape reappears at the bottom and moves away
        c.update([s], 0.6)
    assert c.passed == 0


# ---------- end to end ----------

@pytest.mark.parametrize("effects", [None, "murky"])
def test_bot_following_the_advice_passes_all_tapes(effects):
    res = run(STARTS[1], effects=effects)
    assert res.passed == 4 and res.counted == 4 and res.stopped, str(res)
    assert res.max_offset < 0.10 and res.floor_contacts == 0
