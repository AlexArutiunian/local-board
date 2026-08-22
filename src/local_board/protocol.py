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
MAX_OBJECT_DIMENSION = 20_000.0
MAX_TRANSLATION = 100_000.0
MUTATION_TYPES = {
    "stroke.begin",
    "stroke.append",
    "stroke.end",
    "stroke.delete",
    "stroke.restore",
    "stroke.translate",
    "object.create",
    "object.update",
    "object.delete",
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
    if payload.get("source_zoom") is not None:
        source_zoom = _number(payload.get("source_zoom"), "stroke.source_zoom")
        stroke["source_zoom"] = min(MAX_SOURCE_ZOOM, max(MIN_SOURCE_ZOOM, source_zoom))
    return stroke


def normalize_board_object(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProtocolError("invalid object")
    kind = str(payload.get("kind", "image"))
    if kind != "image":
        raise ProtocolError("unsupported object kind")
    width = _number(payload.get("width"), "object.width")
    height = _number(payload.get("height"), "object.height")
    if not 1 <= width <= MAX_OBJECT_DIMENSION or not 1 <= height <= MAX_OBJECT_DIMENSION:
        raise ProtocolError("invalid object dimensions")
    src = _nonempty_string(payload.get("src"), "object.src", max_length=512)
    if not src.startswith("/api/boards/"):
        raise ProtocolError("invalid object src")
    name = str(payload.get("name", "image"))[:160] or "image"
    return {
        "id": _nonempty_string(payload.get("id"), "object.id"),
        "kind": kind,
        "x": _number(payload.get("x"), "object.x"),
        "y": _number(payload.get("y"), "object.y"),
        "width": width,
        "height": height,
        "src": src,
        "name": name,
    }


def normalize_object_patch(payload: Any) -> dict[str, float]:
    if not isinstance(payload, dict):
        raise ProtocolError("invalid object patch")
    patch: dict[str, float] = {}
    for field in ("x", "y", "width", "height"):
        if field not in payload:
            continue
        value = _number(payload[field], f"object.{field}")
        if field in {"width", "height"} and not 1 <= value <= MAX_OBJECT_DIMENSION:
            raise ProtocolError("invalid object dimensions")
        patch[field] = value
    if not patch:
        raise ProtocolError("empty object patch")
    return patch


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
        event["stroke"] = normalize_stroke(payload.get("stroke"), max_points=MAX_POINTS_PER_STROKE)
    elif message_type == "stroke.append":
        event["stroke_id"] = _nonempty_string(payload.get("stroke_id"), "stroke_id")
        event["points"] = normalize_points(payload.get("points"))
    elif message_type in {"stroke.end", "stroke.delete"}:
        event["stroke_id"] = _nonempty_string(payload.get("stroke_id"), "stroke_id")
    elif message_type == "stroke.translate":
        event["stroke_id"] = _nonempty_string(payload.get("stroke_id"), "stroke_id")
        dx = _number(payload.get("dx"), "dx")
        dy = _number(payload.get("dy"), "dy")
        if abs(dx) > MAX_TRANSLATION or abs(dy) > MAX_TRANSLATION:
            raise ProtocolError("translation too large")
        event["dx"] = dx
        event["dy"] = dy
    elif message_type == "object.create":
        event["object"] = normalize_board_object(payload.get("object"))
    elif message_type == "object.update":
        event["object_id"] = _nonempty_string(payload.get("object_id"), "object_id")
        event["patch"] = normalize_object_patch(payload.get("patch"))
    elif message_type == "object.delete":
        event["object_id"] = _nonempty_string(payload.get("object_id"), "object_id")

    return event
