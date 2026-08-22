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


@dataclass
class BoardObject:
    id: str
    author_id: str
    kind: str
    x: float
    y: float
    width: float
    height: float
    src: str
    name: str = "image"
    crop_x: float = 0.0
    crop_y: float = 0.0
    crop_width: float = 1.0
    crop_height: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "author_id": self.author_id,
            "kind": self.kind,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "src": self.src,
            "name": self.name,
            "crop_x": self.crop_x,
            "crop_y": self.crop_y,
            "crop_width": self.crop_width,
            "crop_height": self.crop_height,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "BoardObject":
        return cls(
            id=str(payload["id"]),
            author_id=str(payload.get("author_id", "unknown")),
            kind=str(payload.get("kind", "image")),
            x=float(payload.get("x", 0)),
            y=float(payload.get("y", 0)),
            width=float(payload.get("width", 320)),
            height=float(payload.get("height", 240)),
            src=str(payload.get("src", "")),
            name=str(payload.get("name", "image")),
            crop_x=float(payload.get("crop_x", 0.0)),
            crop_y=float(payload.get("crop_y", 0.0)),
            crop_width=float(payload.get("crop_width", 1.0)),
            crop_height=float(payload.get("crop_height", 1.0)),
        )
