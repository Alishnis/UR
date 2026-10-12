"""Find which camera index is the USB webcam (vs. the built-in / iPhone camera). Run from host/: python -m tools.list_cameras"""
import sys
from pathlib import Path

import cv2

BACKEND = cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY
OUT_DIR = Path(__file__).resolve().parent.parent / "captures"


def main():
    OUT_DIR.mkdir(exist_ok=True)
    found = 0
    for index in range(6):
        cap = cv2.VideoCapture(index, BACKEND)
        if not cap.isOpened():
            cap.release()
            break  # macOS numbers cameras 0..N-1 without gaps
        for _ in range(10):  # first frames are often black while the camera starts
            ok, frame = cap.read()
        cap.release()
        if not ok:
            print(f"index {index}: opens but gives no frames")
            continue
        h, w = frame.shape[:2]
        path = OUT_DIR / f"camera_{index}.png"
        cv2.imwrite(str(path), frame)
        print(f"index {index}: OK {w}x{h}  snapshot -> {path}")
        found += 1
    if not found:
        print("No cameras. On macOS allow Camera access for your terminal / VS Code in "
              "System Settings -> Privacy & Security -> Camera, then restart it.")
    else:
        print("Open the snapshots to see which index is which camera.")


if __name__ == "__main__":
    main()
