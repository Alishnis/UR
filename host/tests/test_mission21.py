import cv2
import numpy as np
import pytest

from vision.apriltag_detector import DetectorConfig, TagDetector
from vision.tag_image import render_tag
from vision.tag_tracker import Rule, TagTracker, select_target

TAG_IDS = [17, 245, 503]


def test_select_target_rules():
    assert select_target([17, 503, 245], Rule.LARGEST) == 503
    assert select_target([17, 503, 245], Rule.SMALLEST) == 17


def test_select_target_needs_rule_and_ids():
    assert select_target([1, 2, 3], None) is None
    assert select_target([], Rule.LARGEST) is None


def test_tracker_confirms_only_after_n_frames():
    tr = TagTracker(confirm_frames=3)
    assert tr.update([5], 0.0) == []
    assert tr.update([5], 0.1) == []
    assert tr.update([5], 0.2) == [5]
    assert tr.update([5], 0.3) == []
    assert tr.confirmed_ids() == [5]


def test_tracker_remembers_tags_seen_one_at_a_time():
    tr = TagTracker(confirm_frames=2)
    for tag_id in TAG_IDS:
        tr.update([tag_id], 0.0)
        tr.update([tag_id], 0.1)
    assert tr.confirmed_ids() == sorted(TAG_IDS)


def test_tracker_single_frame_glitch_is_not_confirmed():
    tr = TagTracker(confirm_frames=5)
    tr.update([999], 0.0)
    assert tr.confirmed_ids() == []


def test_tracker_undo_ignores_false_positive_until_reset():
    tr = TagTracker(confirm_frames=1)
    tr.update([10, 20], 0.0)
    tr.update([99], 0.1)
    assert tr.undo_last() == 99
    tr.update([99], 0.2)
    assert tr.confirmed_ids() == [10, 20]
    tr.reset()
    tr.update([99], 0.3)
    assert tr.confirmed_ids() == [99]


def make_scene(underwater: bool) -> np.ndarray:
    canvas = np.full((720, 1280, 3), 170, np.uint8)
    # different sizes simulate different distances; 60 px is roughly a 16.2 cm tag a few metres away at 720p
    for tag_id, size, x in zip(TAG_IDS, (160, 100, 60), (80, 520, 950)):
        tag = cv2.cvtColor(render_tag(tag_id, size), cv2.COLOR_GRAY2BGR)
        h, w = tag.shape[:2]
        canvas[200:200 + h, x:x + w] = tag
    if underwater:
        tint = np.array([1.0, 0.85, 0.45])  # BGR: red absorbed first, scene turns blue-green
        canvas = (canvas * tint * 0.55).astype(np.uint8)
        canvas = cv2.GaussianBlur(canvas, (5, 5), 1.5)
        noise = np.random.default_rng(0).normal(0, 6, canvas.shape)
        canvas = np.clip(canvas + noise, 0, 255).astype(np.uint8)
    return canvas


@pytest.mark.parametrize("underwater", [False, True])
@pytest.mark.parametrize("clahe", [False, True])
def test_detector_finds_all_three_tags(underwater, clahe):
    det = TagDetector(DetectorConfig(use_clahe=clahe))
    found = sorted(d.id for d in det.detect(make_scene(underwater)))
    assert found == sorted(TAG_IDS)


def test_detector_ignores_empty_frame():
    det = TagDetector()
    assert det.detect(np.full((720, 1280, 3), 128, np.uint8)) == []
