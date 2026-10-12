import numpy as np

from tests.test_mission21 import TAG_IDS, make_scene
from vision.apriltag_detector import DetectorConfig, TagDetector
from vision.tag_tracker import TagTracker
from vision.underwater_sim import PRESETS, SimParams, degrade, preset_name


def test_zero_params_leave_frame_untouched():
    frame = make_scene(False)
    assert degrade(frame, SimParams()) is frame


def test_every_preset_keeps_shape_and_dtype():
    frame = make_scene(False)
    for p in PRESETS.values():
        out = degrade(frame, p, np.random.default_rng(0))
        assert out.shape == frame.shape and out.dtype == np.uint8


def test_preset_name():
    assert preset_name(PRESETS["murky"]) == "murky"
    assert preset_name(SimParams(tint=1)) == "custom"


def test_clear_water_detects_all_tags():
    det = TagDetector()
    img = degrade(make_scene(False), PRESETS["clear"], np.random.default_rng(0))
    assert sorted(d.id for d in det.detect(img)) == sorted(TAG_IDS)


def test_murky_water_with_clahe_confirms_all_tags_over_time():
    # single murky frames may miss a tag; the tracker must still collect all three within a second of video
    det = TagDetector(DetectorConfig(use_clahe=True))
    tracker = TagTracker(confirm_frames=5)
    scene = make_scene(False)
    for i in range(30):
        img = degrade(scene, PRESETS["murky"], np.random.default_rng(i))
        tracker.update([d.id for d in det.detect(img)], i / 30)
    assert tracker.confirmed_ids() == sorted(TAG_IDS)


def test_bad_water_produces_no_false_tags():
    # in "bad" water it is fine to see nothing, but never a wrong ID
    det = TagDetector(DetectorConfig(use_clahe=True))
    for i in range(10):
        img = degrade(make_scene(False), PRESETS["bad"], np.random.default_rng(i))
        assert set(d.id for d in det.detect(img)) <= set(TAG_IDS)
