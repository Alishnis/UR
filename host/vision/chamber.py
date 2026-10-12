"""Mission 2.2 chamber geometry, shared by the docking guidance and the simulator.

World frame (simulator): X right along the row of cells, Y forward (into the chambers), Z up, pool floor z = 0.
Tags face the approaching ROV (normal = -Y). Tag frame follows pupil-apriltags (checked empirically):
seen from the front, x points LEFT, y points UP, z points into the tag (away from the viewer).
"""
from dataclasses import dataclass

import numpy as np

from vision.apriltag_detector import TAG_SIZE_M

CELL = 0.70  # m, each of the three cells is 70 x 70 x 70 cm (frame 210 x 70 x 70)
N_CELLS = 3
PIPE_D = 0.025  # m, assumed outer diameter of the organisers' PVC pipe - measure it on the day

# Tag centre relative to the entrance centre of its cell, in world axes (X right, Y forward, Z up).
# The manual does not say where the tags are mounted. Confirm on the day and pick the matching mount.
TAG_MOUNTS = {
    "above": np.array([0.0, 0.0, CELL / 2 + 0.15]),  # just above the top bar of the entrance
    "back": np.array([0.0, CELL, 0.0]),  # on the back face of the cell, seen through the entrance
}

# columns = tag x, y, z axes expressed in world axes, for a tag facing -Y
TAG_AXES_WORLD = np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])


def world_to_tag(vec_world: np.ndarray) -> np.ndarray:
    return TAG_AXES_WORLD.T @ vec_world


def entrance_in_tag(mount: str) -> np.ndarray:
    """Entrance centre expressed in the tag frame (what the guidance aims for)."""
    return world_to_tag(-TAG_MOUNTS[mount])


def dock_point_in_tag(mount: str) -> np.ndarray:
    """Cell centre (where the ROV should end up) in the tag frame."""
    return world_to_tag(np.array([0.0, CELL / 2, 0.0]) - TAG_MOUNTS[mount])


def entrance_corners_in_tag(mount: str) -> np.ndarray:
    """4x3 corners of the 70x70 cm entrance opening in the tag frame, for drawing."""
    c = entrance_in_tag(mount)
    h = CELL / 2
    return np.array([c + [-h, -h, 0], c + [h, -h, 0], c + [h, h, 0], c + [-h, h, 0]])


@dataclass
class ChamberWorld:
    """Placement of the frame in the simulated pool."""
    origin: np.ndarray  # world position of the front-bottom-left corner of the frame
    mount: str = "above"
    floor_offset: float = PIPE_D / 2  # bottom bars rest on the floor

    def cell_x0(self, i: int) -> float:
        return self.origin[0] + i * CELL

    def entrance_center(self, i: int) -> np.ndarray:
        return self.origin + np.array([i * CELL + CELL / 2, 0.0, self.floor_offset + CELL / 2])

    def tag_center(self, i: int) -> np.ndarray:
        return self.entrance_center(i) + TAG_MOUNTS[self.mount]

    def cell_box(self, i: int) -> tuple[np.ndarray, np.ndarray]:
        lo = self.origin + np.array([i * CELL, 0.0, self.floor_offset])
        return lo, lo + CELL

    def bars(self) -> np.ndarray:
        """Kx2x3 pipe segments (centre lines) of the frame."""
        o = self.origin + np.array([0.0, 0.0, self.floor_offset])
        xs = [i * CELL for i in range(N_CELLS + 1)]
        segs = []
        for y in (0.0, CELL):
            for z in (0.0, CELL):
                segs.append(([0.0, y, z], [N_CELLS * CELL, y, z]))  # long bars along X
        for x in xs:
            for z in (0.0, CELL):
                segs.append(([x, 0.0, z], [x, CELL, z]))  # depth bars along Y
            for y in (0.0, CELL):
                segs.append(([x, y, 0.0], [x, y, CELL]))  # vertical posts
        return np.array(segs) + o

    def tag_corners_world(self, i: int, size: float) -> np.ndarray:
        """4x3 corners (TL, TR, BR, BL as seen from the front) of a square of `size` centred on the tag."""
        c = self.tag_center(i)
        right, down = np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0])  # as seen from the front
        h = size / 2
        return np.array([c - h * right - h * down, c + h * right - h * down,
                         c + h * right + h * down, c - h * right + h * down])


TAG_IMAGE_SCALE = 1.5  # render_tag adds a white border of 1/4 on each side: full image = 1.5 x black square
TAG_FULL_M = TAG_SIZE_M * TAG_IMAGE_SCALE
