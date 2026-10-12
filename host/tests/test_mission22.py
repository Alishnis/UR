import math

import cv2
import numpy as np
import pytest

from sim.autopilot import run as autopilot_run
from sim.pool_sim import PoolSim
from tools.calibrate_camera import calibrate
from vision.apriltag_detector import TagDetector
from vision.camera_model import CameraModel
from vision.chamber import CELL, TAG_AXES_WORLD, TAG_MOUNTS, ChamberWorld, entrance_in_tag
from vision.docking import (RovConfig, RowLayout, Tolerances, compute_guidance, lost_advice, row_rotation,
                            staging_distance)
from vision.tag_tracker import Rule

IDS = [17, 245, 503]


def rot_err_deg(A, B):
    return math.degrees(math.acos(np.clip((np.trace(A.T @ B) - 1) / 2, -1, 1)))


# ---------- camera model ----------

def test_camera_model_fov_scaling_water_and_file(tmp_path):
    cam = CameraModel.from_hfov(1280, 720, 70)
    assert cam.hfov_deg == pytest.approx(70)
    half = cam.scaled_to(640, 360)
    assert half.fx == pytest.approx(cam.fx / 2) and half.cx == pytest.approx(320)
    assert cam.in_water().fx == pytest.approx(cam.fx * 1.333)
    cam.save(tmp_path / "c.json", rms=0.3)
    assert CameraModel.load(tmp_path / "c.json") == cam


def test_calibration_recovers_focal_length():
    true = CameraModel.from_hfov(1280, 720, 65)
    cols, rows = 9, 6
    obj = np.zeros((cols * rows, 3))
    obj[:, :2] = np.mgrid[0:cols, 0:rows].T.reshape(-1, 2) * 0.03
    rng = np.random.default_rng(0)
    views = []
    for _ in range(15):
        rvec = rng.uniform(-0.5, 0.5, 3)
        tvec = np.array([rng.uniform(-0.15, 0.0), rng.uniform(-0.1, 0.0), rng.uniform(0.4, 0.8)])
        pts, _ = cv2.projectPoints(obj, rvec, tvec, true.K, None)
        views.append((pts + rng.normal(0, 0.2, pts.shape)).astype(np.float32))
    rms, K, _ = calibrate(views, cols, rows, (1280, 720))
    assert rms < 0.5
    assert K[0, 0] == pytest.approx(true.fx, rel=0.02)


# ---------- geometry ----------

def test_tag_frame_is_right_handed_and_mounts_make_sense():
    assert np.linalg.det(TAG_AXES_WORLD) == pytest.approx(1)
    np.testing.assert_allclose(entrance_in_tag("above"), [0, -(CELL / 2 + 0.15), 0])  # entrance is below the tag
    np.testing.assert_allclose(entrance_in_tag("back"), [0, 0, -CELL])  # entrance is in front of the tag
    assert len(ChamberWorld(np.zeros(3)).bars()) == 20


def test_staging_distance_longer_for_tag_above_entrance():
    vfov = CameraModel.from_hfov(1280, 720, 70).vfov_deg
    assert staging_distance(TAG_MOUNTS["above"], vfov, 0) > 1.5
    assert staging_distance(TAG_MOUNTS["back"], vfov, 0) == pytest.approx(0.8)


# ---------- pose from the detector vs simulator ground truth ----------

@pytest.mark.parametrize("pose", [((-0.5, 1.5, 0.5), 15), ((0.6, 1.0, 1.2), 25)])
def test_detector_pose_matches_simulator_truth(pose):
    sim = PoolSim(IDS, seed=0)
    sim.set_pose(*pose)
    found = TagDetector().detect(sim.render(), sim.camera)
    assert found
    for d in found:
        R_true, t_true = sim.true_tag_pose(IDS.index(d.id))
        assert np.linalg.norm(d.t - t_true) < 0.03
        assert rot_err_deg(R_true, d.R) < 6


def test_row_rotation_is_more_accurate_than_one_tag():
    sim = PoolSim(IDS, seed=0)
    sim.set_pose((0.3, 0.4, 0.7), -10)
    found = TagDetector().detect(sim.render(), sim.camera)
    target = next(d for d in found if d.id == 503)
    R_row = row_rotation([d.t for d in found], target.t, 0)
    assert rot_err_deg(sim.true_tag_pose(2)[0], R_row) < 2


def test_row_layout_estimates_hidden_target():
    sim = PoolSim(IDS, seed=0)
    sim.set_pose((0.0, 0.5, 0.7), 0)
    truth = {i: sim.true_tag_pose(k) for k, i in enumerate(IDS)}
    layout = RowLayout()
    layout.update(truth)  # learned while all three were visible
    R, t = layout.estimate(503, {17: truth[17]})  # later only the leftmost tag is visible
    assert np.linalg.norm(t - truth[503][1]) < 0.01


# ---------- guidance logic ----------

def guidance_at(pos, yaw, mount="back", rov=None):
    rov = rov or RovConfig()
    sim = PoolSim(IDS, rov=rov, mount=mount, seed=0)
    sim.set_pose(pos, yaw)
    R, t = sim.true_tag_pose(2)  # target: right cell, entrance centre x = 0.7, y = 3.0, z ~ 0.36
    stage = staging_distance(TAG_MOUNTS[mount], sim.camera.vfov_deg, 0)
    cam_y = pos[1] + rov.length / 2
    return compute_guidance(R, t, entrance_in_tag(mount), rov, Tolerances.for_rov(rov), stage), cam_y


def test_on_axis_and_straight_means_forward():
    g, _ = guidance_at((0.7, 1.0, 0.36), 0)
    assert g.aligned and g.commands == ["FORWARD"]
    assert abs(g.lateral) < 0.01 and abs(g.yaw_deg) < 0.5


def test_heading_error_far_away_asks_to_turn_back_to_axis():
    g, _ = guidance_at((0.7, 0.5, 0.36), 20)  # nose turned 20 deg to the right
    assert g.yaw_deg == pytest.approx(-20, abs=0.5)
    assert g.commands[-1].startswith("TURN LEFT")


def test_sideways_offset_with_room_steers_towards_axis():
    g, _ = guidance_at((1.1, 0.0, 0.36), 0)  # 40 cm right of the axis, 2.8 m out
    assert g.lateral == pytest.approx(0.4, abs=0.01)
    assert g.commands[-1].startswith("TURN LEFT")


def test_sideways_offset_too_close_means_back_up():
    g, _ = guidance_at((0.95, 2.3, 0.36), 0)  # 25 cm off, 0.5 m from the entrance
    assert g.commands[-1].startswith("BACK UP")


def test_vertical_offset_is_reported():
    g, _ = guidance_at((0.7, 1.0, 0.70), 0)
    assert g.commands[0].startswith("DOWN")


def test_inside_window_means_docked():
    rov = RovConfig()
    g, _ = guidance_at((0.7, 3.0 + 0.35, 0.36), 0, rov=rov)  # ROV centred in the cell
    assert g.commands[-1] == "STOP - DOCKED"


def test_too_big_rov_does_not_fit():
    assert not Tolerances.for_rov(RovConfig(width=0.69)).fits
    assert Tolerances.for_rov(RovConfig(width=0.40)).fits


def test_blind_countdown_runs_out_into_stop():
    g, _ = guidance_at((0.7, 2.0, 0.36), 0, mount="above")
    rov = RovConfig()
    assert lost_advice(g, rov, 0.5, 1.8).startswith("BLIND")
    assert lost_advice(g, rov, 60, 1.8).startswith("STOP")


# ---------- simulator ----------

def test_contact_with_frame_is_detected_and_scored():
    sim = PoolSim(IDS, seed=0)
    sim.set_pose((0.35, 3.0, 0.36), 0)  # straddling the post between the middle and right cells
    sim.step(0.05)
    assert sim.status.contacts == 1


def test_docking_in_correct_and_wrong_cell():
    sim = PoolSim(IDS, seed=0)
    sim.set_pose((0.7, 3.35, 0.37), 0)
    sim.step(0.01)
    assert sim.score(Rule.LARGEST) == (20, "docked ID 503 clean")
    assert sim.score(Rule.SMALLEST)[0] == 0


@pytest.mark.parametrize("mount,start", [("back", ((0.0, 0.4, 0.7), 0)), ("above", ((0.7, 0.8, 0.5), -20))])
def test_bot_following_the_advice_docks_cleanly(mount, start):
    points, text, contacts, _ = autopilot_run(mount, *start)
    assert (points, contacts) == (20, 0), text
