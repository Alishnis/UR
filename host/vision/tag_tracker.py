from dataclasses import dataclass
from enum import Enum


class Rule(Enum):
    LARGEST = "largest"
    SMALLEST = "smallest"


def select_target(ids, rule: Rule | None) -> int | None:
    ids = list(ids)
    if rule is None or not ids:
        return None
    return max(ids) if rule is Rule.LARGEST else min(ids)


@dataclass
class TagRecord:
    hits: int = 0
    first_seen: float = 0.0
    last_seen: float = 0.0
    confirmed: bool = False


class TagTracker:
    """Remembers tags across the whole attempt, because the camera may see only one tag at a time."""

    def __init__(self, confirm_frames: int = 5):
        self.confirm_frames = confirm_frames
        self.records: dict[int, TagRecord] = {}
        self._confirm_order: list[int] = []
        self._ignored: set[int] = set()

    def update(self, ids, now: float) -> list[int]:
        """Feed IDs seen in one frame; returns IDs that became confirmed on this frame."""
        newly = []
        for tag_id in set(ids):
            if tag_id in self._ignored:
                continue
            rec = self.records.setdefault(tag_id, TagRecord(first_seen=now))
            rec.hits += 1
            rec.last_seen = now
            if not rec.confirmed and rec.hits >= self.confirm_frames:
                rec.confirmed = True
                self._confirm_order.append(tag_id)
                newly.append(tag_id)
        return newly

    def confirmed_ids(self) -> list[int]:
        return sorted(self._confirm_order)

    def undo_last(self) -> int | None:
        """Drop the most recently confirmed ID and ignore it until reset (it was a false positive)."""
        if not self._confirm_order:
            return None
        tag_id = self._confirm_order.pop()
        self.records.pop(tag_id, None)
        self._ignored.add(tag_id)
        return tag_id

    def reset(self) -> None:
        self.records.clear()
        self._confirm_order.clear()
        self._ignored.clear()
