from __future__ import annotations

import math
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdf_canvas

WORLD_TO_PT = 72.0 / 96.0
PAGE_MARGIN_PT = 24.0
CONTENT_PADDING_WORLD = 32.0
DEFAULT_EMPTY_WIDTH = 720.0
DEFAULT_EMPTY_HEIGHT = 960.0

PAPER_COLORS = {
    "white": "#ffffff",
    "warm": "#fffaf0",
    "gray": "#f4f4f5",
    "blue": "#f5f9ff",
    "green": "#f5fbf7",
}
LINE_COLORS = {
    "white": "#dedbd8",
    "gray": "#d8d6d5",
    "warm": "#e4ddd1",
    "blue": "#dce6f2",
    "green": "#dce8df",
}
STRONG_LINE_COLORS = {
    "white": "#c7c3c0",
    "gray": "#c5c2c0",
    "warm": "#cfc4b4",
    "blue": "#c3d3e6",
    "green": "#c3d8ca",
}


def board_content_bounds(document: dict[str, Any]) -> dict[str, float]:
    min_x = math.inf
    min_y = math.inf
    max_x = -math.inf
    max_y = -math.inf

    for stroke in document.get("strokes", []) or []:
        points = stroke.get("points") if isinstance(stroke, dict) else None
        if not isinstance(points, list) or not points:
            continue
        half_width = max(1.0, float(stroke.get("width", 4.0) or 4.0)) / 2.0
        xs = [float(point.get("x", 0.0)) for point in points if isinstance(point, dict)]
        ys = [float(point.get("y", 0.0)) for point in points if isinstance(point, dict)]
        if not xs or not ys:
            continue
        min_x = min(min_x, min(xs) - half_width)
        min_y = min(min_y, min(ys) - half_width)
        max_x = max(max_x, max(xs) + half_width)
        max_y = max(max_y, max(ys) + half_width)

    for obj in document.get("objects", []) or []:
        if not isinstance(obj, dict) or obj.get("kind", "image") != "image":
            continue
        x = float(obj.get("x", 0.0) or 0.0)
        y = float(obj.get("y", 0.0) or 0.0)
        width = max(1.0, float(obj.get("width", 1.0) or 1.0))
        height = max(1.0, float(obj.get("height", 1.0) or 1.0))
        min_x = min(min_x, x)
        min_y = min(min_y, y)
        max_x = max(max_x, x + width)
        max_y = max(max_y, y + height)

    if not math.isfinite(min_x):
        return {"x": 0.0, "y": 0.0, "width": DEFAULT_EMPTY_WIDTH, "height": DEFAULT_EMPTY_HEIGHT}

    return {
        "x": min_x - CONTENT_PADDING_WORLD,
        "y": min_y - CONTENT_PADDING_WORLD,
        "width": max(1.0, max_x - min_x + CONTENT_PADDING_WORLD * 2.0),
        "height": max(1.0, max_y - min_y + CONTENT_PADDING_WORLD * 2.0),
    }


def build_board_pdf(
    board_id: str,
    document: dict[str, Any],
    *,
    asset_path: Callable[[str], Path],
) -> bytes:
    bounds = board_content_bounds(document)
    page_size = landscape(A4) if bounds["width"] > bounds["height"] * 1.2 else A4
    page_width, page_height = page_size
    usable_width = page_width - PAGE_MARGIN_PT * 2.0
    usable_height = page_height - PAGE_MARGIN_PT * 2.0
    tile_world_width = usable_width / WORLD_TO_PT
    tile_world_height = usable_height / WORLD_TO_PT
    columns = max(1, math.ceil(bounds["width"] / tile_world_width))
    rows = max(1, math.ceil(bounds["height"] / tile_world_height))
    total_pages = columns * rows

    output = BytesIO()
    pdf = pdf_canvas.Canvas(output, pagesize=page_size, pageCompression=1)
    pdf.setTitle(f"Studybruh board {board_id}")
    pdf.setCreator("Studybruh Local Board")
    image_cache: dict[str, ImageReader | None] = {}

    page_index = 0
    for row in range(rows):
        for column in range(columns):
            page_index += 1
            tile = {
                "x": bounds["x"] + column * tile_world_width,
                "y": bounds["y"] + row * tile_world_height,
                "width": tile_world_width,
                "height": tile_world_height,
            }
            _draw_page(
                pdf,
                document,
                tile,
                page_width,
                page_height,
                board_id=board_id,
                asset_path=asset_path,
                image_cache=image_cache,
            )
            if total_pages > 1:
                pdf.setFillColor(HexColor("#8b8b88"))
                pdf.setFont("Helvetica", 7)
                pdf.drawRightString(page_width - PAGE_MARGIN_PT, 9, f"{page_index}/{total_pages}")
            pdf.showPage()

    pdf.save()
    return output.getvalue()


def _draw_page(
    pdf: pdf_canvas.Canvas,
    document: dict[str, Any],
    tile: dict[str, float],
    page_width: float,
    page_height: float,
    *,
    board_id: str,
    asset_path: Callable[[str], Path],
    image_cache: dict[str, ImageReader | None],
) -> None:
    clip = pdf.beginPath()
    clip.rect(PAGE_MARGIN_PT, PAGE_MARGIN_PT, page_width - PAGE_MARGIN_PT * 2, page_height - PAGE_MARGIN_PT * 2)
    pdf.saveState()
    pdf.clipPath(clip, stroke=0, fill=0)

    _draw_background(pdf, document.get("background") or {}, tile, page_width, page_height)

    for obj in document.get("objects", []) or []:
        if not isinstance(obj, dict) or obj.get("kind", "image") != "image":
            continue
        if not _rect_intersects_tile(_object_bounds(obj), tile):
            continue
        _draw_image(
            pdf,
            obj,
            tile,
            page_height,
            board_id=board_id,
            asset_path=asset_path,
            image_cache=image_cache,
        )

    for stroke in document.get("strokes", []) or []:
        if not isinstance(stroke, dict):
            continue
        stroke_bounds = _stroke_bounds(stroke)
        if stroke_bounds is None or not _rect_intersects_tile(stroke_bounds, tile):
            continue
        _draw_stroke(pdf, stroke, tile, page_height)

    pdf.restoreState()


def _draw_background(
    pdf: pdf_canvas.Canvas,
    background: dict[str, Any],
    tile: dict[str, float],
    page_width: float,
    page_height: float,
) -> None:
    tone = str(background.get("tone") or "white")
    pattern = str(background.get("pattern") or "dots")
    paper = PAPER_COLORS.get(tone, PAPER_COLORS["white"])
    line = LINE_COLORS.get(tone, LINE_COLORS["white"])
    strong = STRONG_LINE_COLORS.get(tone, STRONG_LINE_COLORS["white"])
    usable_width = page_width - PAGE_MARGIN_PT * 2
    usable_height = page_height - PAGE_MARGIN_PT * 2

    pdf.setFillColor(HexColor(paper))
    pdf.rect(PAGE_MARGIN_PT, PAGE_MARGIN_PT, usable_width, usable_height, stroke=0, fill=1)
    if pattern == "plain":
        return

    if pattern == "dots":
        pdf.setFillColor(HexColor(line))
        for x in _aligned_values(tile["x"], tile["x"] + tile["width"], 28.0):
            for y in _aligned_values(tile["y"], tile["y"] + tile["height"], 28.0):
                px, py = _world_to_page(x, y, tile, page_height)
                pdf.circle(px, py, 0.72, stroke=0, fill=1)
        return

    pdf.setLineWidth(0.55)
    pdf.setStrokeColor(HexColor(line))
    if pattern in {"grid", "fine-grid"}:
        spacing = 18.0 if pattern == "fine-grid" else 28.0
        _draw_grid(pdf, tile, page_height, spacing)
        if pattern == "fine-grid":
            pdf.setStrokeColor(HexColor(strong))
            pdf.setLineWidth(0.7)
            _draw_grid(pdf, tile, page_height, spacing * 5.0)
    elif pattern == "ruled":
        _draw_horizontal_lines(pdf, tile, page_height, 32.0)
    elif pattern == "cornell":
        _draw_horizontal_lines(pdf, tile, page_height, 32.0)
        pdf.setStrokeColor(HexColor(strong))
        pdf.setLineWidth(0.8)
        if tile["x"] <= 150.0 <= tile["x"] + tile["width"]:
            x1, y1 = _world_to_page(150.0, tile["y"], tile, page_height)
            _, y2 = _world_to_page(150.0, tile["y"] + tile["height"], tile, page_height)
            pdf.line(x1, y1, x1, y2)
        if tile["y"] <= 96.0 <= tile["y"] + tile["height"]:
            x1, y = _world_to_page(tile["x"], 96.0, tile, page_height)
            x2, _ = _world_to_page(tile["x"] + tile["width"], 96.0, tile, page_height)
            pdf.line(x1, y, x2, y)
    elif pattern == "isometric":
        _draw_isometric(pdf, tile, page_height)


def _draw_grid(pdf: pdf_canvas.Canvas, tile: dict[str, float], page_height: float, spacing: float) -> None:
    for x in _aligned_values(tile["x"], tile["x"] + tile["width"], spacing):
        px, py1 = _world_to_page(x, tile["y"], tile, page_height)
        _, py2 = _world_to_page(x, tile["y"] + tile["height"], tile, page_height)
        pdf.line(px, py1, px, py2)
    _draw_horizontal_lines(pdf, tile, page_height, spacing)


def _draw_horizontal_lines(pdf: pdf_canvas.Canvas, tile: dict[str, float], page_height: float, spacing: float) -> None:
    for y in _aligned_values(tile["y"], tile["y"] + tile["height"], spacing):
        px1, py = _world_to_page(tile["x"], y, tile, page_height)
        px2, _ = _world_to_page(tile["x"] + tile["width"], y, tile, page_height)
        pdf.line(px1, py, px2, py)


def _draw_isometric(pdf: pdf_canvas.Canvas, tile: dict[str, float], page_height: float) -> None:
    spacing = 32.0
    vertical = spacing * math.sqrt(3.0) / 2.0
    _draw_horizontal_lines(pdf, tile, page_height, vertical)
    slope = 0.57735026919
    y0 = tile["y"]
    y1 = tile["y"] + tile["height"]
    corners = [
        tile["x"] - slope * y0,
        tile["x"] + tile["width"] - slope * y0,
        tile["x"] - slope * y1,
        tile["x"] + tile["width"] - slope * y1,
    ]
    for intercept in _aligned_values(min(corners) - spacing, max(corners) + spacing, spacing):
        x_top = intercept + slope * y0
        x_bottom = intercept + slope * y1
        px1, py1 = _world_to_page(x_top, y0, tile, page_height)
        px2, py2 = _world_to_page(x_bottom, y1, tile, page_height)
        pdf.line(px1, py1, px2, py2)

    corners = [
        tile["x"] + slope * y0,
        tile["x"] + tile["width"] + slope * y0,
        tile["x"] + slope * y1,
        tile["x"] + tile["width"] + slope * y1,
    ]
    for intercept in _aligned_values(min(corners) - spacing, max(corners) + spacing, spacing):
        x_top = intercept - slope * y0
        x_bottom = intercept - slope * y1
        px1, py1 = _world_to_page(x_top, y0, tile, page_height)
        px2, py2 = _world_to_page(x_bottom, y1, tile, page_height)
        pdf.line(px1, py1, px2, py2)


def _draw_stroke(pdf: pdf_canvas.Canvas, stroke: dict[str, Any], tile: dict[str, float], page_height: float) -> None:
    points = [point for point in (stroke.get("points") or []) if isinstance(point, dict)]
    if not points:
        return
    color = str(stroke.get("color") or "#111111")
    try:
        pdf.setStrokeColor(HexColor(color))
        pdf.setFillColor(HexColor(color))
    except ValueError:
        pdf.setStrokeColor(HexColor("#111111"))
        pdf.setFillColor(HexColor("#111111"))
    pressure = sum(float(point.get("pressure", 0.5) or 0.5) for point in points) / len(points)
    pressure_factor = max(0.72, min(1.25, 0.68 + pressure * 0.75)) if stroke.get("pointer_type") == "pen" else 1.0
    width = max(0.65, float(stroke.get("width", 4.0) or 4.0) * WORLD_TO_PT * pressure_factor)
    pdf.setLineWidth(width)
    pdf.setLineCap(1)
    pdf.setLineJoin(1)

    mapped = [_world_to_page(float(point.get("x", 0.0)), float(point.get("y", 0.0)), tile, page_height) for point in points]
    if len(mapped) == 1:
        x, y = mapped[0]
        pdf.circle(x, y, width / 2.0, stroke=0, fill=1)
        return

    path = pdf.beginPath()
    path.moveTo(*mapped[0])
    current = mapped[0]
    for index in range(1, len(mapped) - 1):
        control = mapped[index]
        following = mapped[index + 1]
        end = ((control[0] + following[0]) / 2.0, (control[1] + following[1]) / 2.0)
        c1 = (
            current[0] + (control[0] - current[0]) * 2.0 / 3.0,
            current[1] + (control[1] - current[1]) * 2.0 / 3.0,
        )
        c2 = (
            end[0] + (control[0] - end[0]) * 2.0 / 3.0,
            end[1] + (control[1] - end[1]) * 2.0 / 3.0,
        )
        path.curveTo(c1[0], c1[1], c2[0], c2[1], end[0], end[1])
        current = end
    path.lineTo(*mapped[-1])
    pdf.drawPath(path, stroke=1, fill=0)


def _draw_image(
    pdf: pdf_canvas.Canvas,
    obj: dict[str, Any],
    tile: dict[str, float],
    page_height: float,
    *,
    board_id: str,
    asset_path: Callable[[str], Path],
    image_cache: dict[str, ImageReader | None],
) -> None:
    src = str(obj.get("src") or "")
    prefix = f"/api/boards/{board_id}/assets/"
    if not src.startswith(prefix):
        return
    asset_name = src[len(prefix):].split("?", 1)[0].split("#", 1)[0]
    if not asset_name:
        return

    if asset_name not in image_cache:
        try:
            path = asset_path(asset_name)
            image_cache[asset_name] = ImageReader(str(path)) if path.is_file() else None
        except Exception:
            image_cache[asset_name] = None
    image = image_cache[asset_name]

    x = float(obj.get("x", 0.0) or 0.0)
    y = float(obj.get("y", 0.0) or 0.0)
    width = max(1.0, float(obj.get("width", 1.0) or 1.0))
    height = max(1.0, float(obj.get("height", 1.0) or 1.0))
    left, bottom = _world_rect_to_page(x, y, width, height, tile, page_height)
    dest_width = width * WORLD_TO_PT
    dest_height = height * WORLD_TO_PT

    if image is None:
        pdf.setFillColor(HexColor("#f1f1ef"))
        pdf.setStrokeColor(HexColor("#d6d3d1"))
        pdf.rect(left, bottom, dest_width, dest_height, stroke=1, fill=1)
        return

    crop_x = max(0.0, min(0.999, float(obj.get("crop_x", 0.0) or 0.0)))
    crop_y = max(0.0, min(0.999, float(obj.get("crop_y", 0.0) or 0.0)))
    crop_width = max(0.001, min(1.0 - crop_x, float(obj.get("crop_width", 1.0) or 1.0)))
    crop_height = max(0.001, min(1.0 - crop_y, float(obj.get("crop_height", 1.0) or 1.0)))
    full_width = width / crop_width
    full_height = height / crop_height
    full_x = x - crop_x * full_width
    full_y = y - crop_y * full_height
    full_left, full_bottom = _world_rect_to_page(full_x, full_y, full_width, full_height, tile, page_height)

    pdf.saveState()
    object_clip = pdf.beginPath()
    object_clip.rect(left, bottom, dest_width, dest_height)
    pdf.clipPath(object_clip, stroke=0, fill=0)
    pdf.drawImage(
        image,
        full_left,
        full_bottom,
        width=full_width * WORLD_TO_PT,
        height=full_height * WORLD_TO_PT,
        preserveAspectRatio=False,
        mask="auto",
    )
    pdf.restoreState()


def _stroke_bounds(stroke: dict[str, Any]) -> dict[str, float] | None:
    points = [point for point in (stroke.get("points") or []) if isinstance(point, dict)]
    if not points:
        return None
    xs = [float(point.get("x", 0.0)) for point in points]
    ys = [float(point.get("y", 0.0)) for point in points]
    pad = max(1.0, float(stroke.get("width", 4.0) or 4.0)) / 2.0
    return {"x": min(xs) - pad, "y": min(ys) - pad, "width": max(xs) - min(xs) + pad * 2, "height": max(ys) - min(ys) + pad * 2}


def _object_bounds(obj: dict[str, Any]) -> dict[str, float]:
    return {
        "x": float(obj.get("x", 0.0) or 0.0),
        "y": float(obj.get("y", 0.0) or 0.0),
        "width": max(1.0, float(obj.get("width", 1.0) or 1.0)),
        "height": max(1.0, float(obj.get("height", 1.0) or 1.0)),
    }


def _rect_intersects_tile(rect: dict[str, float], tile: dict[str, float]) -> bool:
    return rect["x"] + rect["width"] >= tile["x"] and rect["x"] <= tile["x"] + tile["width"] and rect["y"] + rect["height"] >= tile["y"] and rect["y"] <= tile["y"] + tile["height"]


def _world_to_page(x: float, y: float, tile: dict[str, float], page_height: float) -> tuple[float, float]:
    return (
        PAGE_MARGIN_PT + (x - tile["x"]) * WORLD_TO_PT,
        page_height - PAGE_MARGIN_PT - (y - tile["y"]) * WORLD_TO_PT,
    )


def _world_rect_to_page(x: float, y: float, width: float, height: float, tile: dict[str, float], page_height: float) -> tuple[float, float]:
    left = PAGE_MARGIN_PT + (x - tile["x"]) * WORLD_TO_PT
    bottom = page_height - PAGE_MARGIN_PT - ((y + height) - tile["y"]) * WORLD_TO_PT
    return left, bottom


def _aligned_values(start: float, end: float, spacing: float):
    if spacing <= 0:
        return
    value = math.floor(start / spacing) * spacing
    while value < start - 1e-6:
        value += spacing
    while value <= end + 1e-6:
        yield value
        value += spacing
