from __future__ import annotations

import base64
import json
import time
import zlib
from typing import Any

from .models import Stroke

PATH_QUANTIZATION = 0.1


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def stroke_activity_summary(stroke: Stroke, *, include_path: bool = False) -> dict[str, Any]:
    points = stroke.points
    summary: dict[str, Any] = {
        "points": len(points),
        "color": stroke.color,
        "width": round(float(stroke.width), 2),
        "pointer": stroke.pointer_type,
    }
    if not points:
        return summary

    min_x = max_x = float(points[0]["x"])
    min_y = max_y = float(points[0]["y"])
    for point in points[1:]:
        x = float(point["x"])
        y = float(point["y"])
        min_x = min(min_x, x)
        min_y = min(min_y, y)
        max_x = max(max_x, x)
        max_y = max(max_y, y)
    summary["bbox"] = [round(min_x, 2), round(min_y, 2), round(max_x, 2), round(max_y, 2)]
    if include_path:
        summary["path_z"] = encode_stroke_path(points)
    return summary


def encode_stroke_path(points: list[dict[str, float]]) -> str:
    """Compact replay payload: quantized [x,y] JSON -> zlib -> base85."""
    quantized = [
        [round(float(point["x"]) / PATH_QUANTIZATION), round(float(point["y"]) / PATH_QUANTIZATION)]
        for point in points
    ]
    raw = json.dumps(quantized, separators=(",", ":")).encode("utf-8")
    return base64.b85encode(zlib.compress(raw, level=6)).decode("ascii")


def decode_stroke_path(payload: str) -> list[dict[str, float]]:
    raw = zlib.decompress(base64.b85decode(payload.encode("ascii")))
    quantized = json.loads(raw.decode("utf-8"))
    return [
        {"x": float(point[0]) * PATH_QUANTIZATION, "y": float(point[1]) * PATH_QUANTIZATION}
        for point in quantized
    ]


def compact_numeric_dict(payload: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, float):
            result[key] = round(value, 4)
        else:
            result[key] = value
    return result
