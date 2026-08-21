from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Stroke:
    id: str
    author_id: str
    color: str
    width: float
    pointer_type: str
    points: list[dict[str, float]] = field(default_factory=list)
    complete: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "author_id": self.author_id,
            "color": self.color,
            "width": self.width,
            "pointer_type": self.pointer_type,
            "points": self.points,
            "complete": self.complete,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Stroke":
        return cls(
            id=str(payload["id"]),
            author_id=str(payload.get("author_id", "unknown")),
            color=str(payload.get("color", "#111111")),
            width=float(payload.get("width", 4.0)),
            pointer_type=str(payload.get("pointer_type", "pen")),
            points=list(payload.get("points", [])),
            complete=bool(payload.get("complete", True)),
        )
