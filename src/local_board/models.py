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
    source_zoom: float | None = None
    points: list[dict[str, float]] = field(default_factory=list)
    complete: bool = False

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "author_id": self.author_id,
            "color": self.color,
            "width": self.width,
            "pointer_type": self.pointer_type,
            "points": self.points,
            "complete": self.complete,
        }
        if self.source_zoom is not None:
            payload["source_zoom"] = self.source_zoom
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Stroke":
        raw_source_zoom = payload.get("source_zoom")
        source_zoom = float(raw_source_zoom) if raw_source_zoom is not None else None
        return cls(
            id=str(payload["id"]),
            author_id=str(payload.get("author_id", "unknown")),
            color=str(payload.get("color", "#111111")),
            width=float(payload.get("width", 4.0)),
            pointer_type=str(payload.get("pointer_type", "pen")),
            source_zoom=source_zoom,
            points=list(payload.get("points", [])),
            complete=bool(payload.get("complete", True)),
        )
