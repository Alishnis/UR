import cv2
import numpy as np

_DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
MAX_TAG_ID = _DICT.bytesList.shape[0] - 1


def render_tag(tag_id: int, black_px: int, margin_px: int | None = None) -> np.ndarray:
    """Grayscale tag36h11 image: black square of black_px plus a white quiet zone (needed for detection)."""
    if not 0 <= tag_id <= MAX_TAG_ID:
        raise ValueError(f"tag36h11 id must be 0..{MAX_TAG_ID}, got {tag_id}")
    margin = black_px // 4 if margin_px is None else margin_px
    marker = cv2.aruco.generateImageMarker(_DICT, tag_id, black_px)
    return cv2.copyMakeBorder(marker, margin, margin, margin, margin, cv2.BORDER_CONSTANT, value=255)
