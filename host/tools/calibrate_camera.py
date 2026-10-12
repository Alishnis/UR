"""Camera calibration with a checkerboard. Run from host/:

    python -m tools.calibrate_camera --make-board          # writes tags/checkerboard.png (show it full screen)
    python -m tools.calibrate_camera --source 0 --out camera_usb.json

Keys: Space capture a view (only when the board is found) | C compute + save (needs 12+ views) | Q quit
Capture 15-25 views: board near and far, tilted left/right/up/down, and in every corner of the image.
For the ROV camera do this UNDERWATER (water changes the focal length by ~1.33x).
"""
import argparse
from pathlib import Path

import cv2
import numpy as np

from ui import GREEN, ORANGE, RED, WHITE, FrameSource, fit_height, put_text, shade_rect
from vision.camera_model import CameraModel

WINDOW = "Camera calibration"
MIN_VIEWS = 12
BOARD_PATH = Path(__file__).resolve().parent.parent / "tags" / "checkerboard.png"


def make_board(cols: int, rows: int, square_px: int = 120) -> Path:
    """Board with (cols+1) x (rows+1) squares, i.e. cols x rows inner corners, plus a white margin."""
    board = np.full(((rows + 1) * square_px, (cols + 1) * square_px), 255, np.uint8)
    for r in range(rows + 1):
        for c in range(cols + 1):
            if (r + c) % 2 == 0:
                board[r * square_px:(r + 1) * square_px, c * square_px:(c + 1) * square_px] = 0
    board = cv2.copyMakeBorder(board, square_px, square_px, square_px, square_px, cv2.BORDER_CONSTANT, value=255)
    BOARD_PATH.parent.mkdir(exist_ok=True)
    cv2.imwrite(str(BOARD_PATH), board)
    return BOARD_PATH


def calibrate(views: list[np.ndarray], cols: int, rows: int, size: tuple[int, int]):
    # square size does not matter for intrinsics (fx, fy, cx, cy), so 1 unit per square
    obj = np.zeros((cols * rows, 3), np.float32)
    obj[:, :2] = np.mgrid[0:cols, 0:rows].T.reshape(-1, 2)
    rms, K, dist, _, _ = cv2.calibrateCamera([obj] * len(views), views, size, None, None)
    return rms, K, dist.ravel()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--make-board", action="store_true", help="only write the checkerboard image and exit")
    ap.add_argument("--source", default="0", help="camera index / URL / video")
    ap.add_argument("--out", default="camera.json", help="output calibration file")
    ap.add_argument("--cols", type=int, default=9, help="inner corners per row")
    ap.add_argument("--rows", type=int, default=6, help="inner corners per column")
    args = ap.parse_args()

    if args.make_board:
        print(f"Saved {make_board(args.cols, args.rows)} - open it full screen on another display or print it")
        return

    source = FrameSource(args.source)
    pattern = (args.cols, args.rows)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    views: list[np.ndarray] = []
    size = None
    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    try:
        while True:
            ok, raw = source.read()
            if not ok:
                cv2.waitKey(20)
                continue
            frame = fit_height(raw)  # same scaling as the mission apps, so the result applies directly
            size = (frame.shape[1], frame.shape[0])
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            found, corners = cv2.findChessboardCorners(
                gray, pattern, cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE | cv2.CALIB_CB_FAST_CHECK)
            shown = frame.copy()
            if found:
                cv2.drawChessboardCorners(shown, pattern, corners, found)
            shade_rect(shown, (0, 0), (620, 110))
            put_text(shown, f"views: {len(views)}/{MIN_VIEWS}+   board {'FOUND' if found else 'not found'}",
                     (15, 35), 0.8, GREEN if found else ORANGE, 2)
            put_text(shown, "Space capture | C compute+save | Q quit", (15, 70), 0.6, WHITE, 1)
            put_text(shown, "vary distance, tilt and image position", (15, 98), 0.55, WHITE, 1)
            cv2.imshow(WINDOW, shown)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord(" ") and found:
                views.append(cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria))
                print(f"captured view {len(views)}")
            elif key == ord("c"):
                if len(views) < MIN_VIEWS:
                    print(f"need at least {MIN_VIEWS} views, have {len(views)}")
                    continue
                rms, K, dist = calibrate(views, args.cols, args.rows, size)
                cam = CameraModel(K[0, 0], K[1, 1], K[0, 2], K[1, 2], size[0], size[1], dist.tolist())
                cam.save(args.out, rms=rms, views=len(views))
                quality = "good" if rms < 0.5 else ("ok" if rms < 1.0 else "poor - recapture")
                print(f"RMS reprojection error {rms:.3f} px ({quality}); HFOV {cam.hfov_deg:.1f} deg")
                print(f"Saved {args.out}. Use: python mission22.py --source {args.source} --calib {args.out}")
                shade_rect(shown, (0, 120), (620, 170))
                put_text(shown, f"saved {args.out}  RMS {rms:.2f}px", (15, 155), 0.7, GREEN if rms < 1 else RED, 2)
                cv2.imshow(WINDOW, shown)
                cv2.waitKey(1500)
    finally:
        source.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
