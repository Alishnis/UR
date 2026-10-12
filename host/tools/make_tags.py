"""Generate tag36h11 images for testing Mission 2.1. Run from host/: python -m tools.make_tags"""
import argparse
import random
from pathlib import Path

import cv2
import numpy as np

from vision.tag_image import MAX_TAG_ID, render_tag

OUT_DIR = Path(__file__).resolve().parent.parent / "tags"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ids", type=int, nargs="+", help="tag IDs (default: 3 random distinct IDs)")
    ap.add_argument("--px", type=int, default=800, help="size of the black square in pixels")
    args = ap.parse_args()

    ids = args.ids or random.sample(range(MAX_TAG_ID + 1), 3)
    OUT_DIR.mkdir(exist_ok=True)

    images = []
    for tag_id in ids:
        img = render_tag(tag_id, args.px)
        cv2.imwrite(str(OUT_DIR / f"tag_{tag_id}.png"), img)
        images.append(img)

    gap = np.full((images[0].shape[0], args.px // 4), 255, np.uint8)
    sheet = images[0]
    for img in images[1:]:
        sheet = np.hstack([sheet, gap, img])
    cv2.imwrite(str(OUT_DIR / "sheet.png"), sheet)

    print(f"IDs: {ids}  -> largest = {max(ids)}, smallest = {min(ids)}")
    print(f"Saved to {OUT_DIR}/ (tag_<id>.png and sheet.png)")
    print("Printing: scale so the BLACK square is 16.2 cm wide (white border is extra).")


if __name__ == "__main__":
    main()
