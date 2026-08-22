from __future__ import annotations

import math
import re
from typing import Any

HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
MAX_POINTS_PER_BATCH = 256
MAX_POINTS_PER_STROKE = 20_000
MAX_WIDTH = 64.0
MIN_SOURCE_ZOOM = 0.2
MAX_SOURCE_ZOOM = 5.0
MUTATION_TYPES = {
    "stroke.begin",
    "stroke.append",
    "stroke.end",
    "stroke.delete",
    "stroke.restore",
    "board.clear",
}


class ProtocolError(ValueError):
    pass


def _nonempty_string(value: Any, field: str, *, max_length: int = 128) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise ProtocolError(f"invalid {field}")
    return value


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError(f"invalid {field}")
    value = float(value)
    if not math.isfinite(value):
        raise ProtocolError(f"invalid {field}")
    return value


def normalize_points(payload: Any, *, max_points: int = MAX_POINTS_PER_BATCH) -> list[dict[str, float]]:
    if not isinstance(payload, list) or not 1 <= len(payload) <= max_points:
        raise ProtocolError("invalid points batch")
    points: list[dict[str, float]] = []
    for point in payload:
        if not isinstance(point, dict):
            raise ProtocolError("invalid point")
        pressure = _number(point.get("pressure", 0.5), "pressure")
        points.append(
            {
                "x": _number(point.get("x"), "x"),
                "y": _number(point.get("y"), "y"),
                "pressure": min(1.0, max(0.0, pressure)),
            }
        )
    return points


def normalize_stroke(payload: Any, *, max_points: int = MAX_POINTS_PER_BATCH) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProtocolError("invalid stroke")
    color = str(payload.get("color", "#111111"))
    if not HEX_COLOR_RE.fullmatch(color):
        raise ProtocolError("invalid stroke color")
    width = _number(payload.get("width", 4), "width")
    if not 0.25 <= width <= MAX_WIDTH:
        raise ProtocolError("invalid stroke width")
    pointer_type = str(payload.get("pointer_type", "pen"))
    if pointer_type not in {"pen", "mouse", "touch"}:
        pointer_type = "pen"

    stroke: dict[str, Any] = {
        "id": _nonempty_string(payload.get("id"), "stroke.id"),
        "color": color,
        "width": width,
        "pointer_type": pointer_type,
        "points": normalize_points(payload.get("points"), max_points=max_points),
    }

    # Optional viewport metadata is descriptive, never authorization/state.
    # It lets another client show the same handwriting at approximately the
    # same visual scale as the device where the stroke was created.
    if payload.get("source_zoom") is not None:
        source_zoom = _number(payload.get("source_zoom"), "stroke.source_zoom")
        stroke["source_zoom"] = min(MAX_SOURCE_ZOOM, max(MIN_SOURCE_ZOOM, source_zoom))

    return stroke


def normalize_client_event(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProtocolError("message must be an object")

    message_type = payload.get("type")
    if message_type == "ping":
        return {"type": "ping"}
    if message_type not in MUTATION_TYPES:
        raise ProtocolError("unknown event type")

    event: dict[str, Any] = {
        "type": message_type,
        "op_id": _nonempty_string(payload.get("op_id"), "op_id"),
    }

    if message_type == "stroke.begin":
        event["stroke"] = normalize_stroke(payload.get("stroke"))
    elif message_type == "stroke.restore":
        event["stroke"] = normalize_stroke(
            payload.get("stroke"), max_points=MAX_POINTS_PER_STROKE
        )
    elif message_type == "stroke.append":
        event["stroke_id"] = _nonempty_string(payload.get("stroke_id"), "stroke_id")
        event["points"] = normalize_points(payload.get("points"))
    elif message_type in {"stroke.end", "stroke.delete"}:
        event["stroke_id"] = _nonempty_string(payload.get("stroke_id"), "stroke_id")

    return event
