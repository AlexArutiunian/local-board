export function strokeKey(id) { return `stroke:${id}`; }
export function objectKey(id) { return `object:${id}`; }

export function parseItemKey(key) {
  const value = String(key || "");
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  return { kind: value.slice(0, separator), id: value.slice(separator + 1) };
}

export function itemBounds(state, key) {
  const parsed = parseItemKey(key);
  if (!parsed) return null;
  if (parsed.kind === "stroke") return strokeBounds(state.getStroke(parsed.id));
  if (parsed.kind === "object") return objectBounds(state.getObject(parsed.id));
  return null;
}

export function strokeBounds(stroke) {
  const points = stroke?.points || [];
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, Number(point.x));
    minY = Math.min(minY, Number(point.y));
    maxX = Math.max(maxX, Number(point.x));
    maxY = Math.max(maxY, Number(point.y));
  }
  const pad = Math.max(2, Number(stroke.width || 4) * 0.7);
  return { x: minX - pad, y: minY - pad, width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2) };
}

export function objectBounds(object) {
  if (!object) return null;
  return {
    x: Number(object.x),
    y: Number(object.y),
    width: Math.max(1, Number(object.width)),
    height: Math.max(1, Number(object.height)),
  };
}

export function allItemKeys(state) {
  return [
    ...state.listStrokes().map((stroke) => strokeKey(stroke.id)),
    ...state.listObjects().map((object) => objectKey(object.id)),
  ];
}

export function hitTest(state, point, tolerance = 8) {
  const objects = state.listObjects();
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i];
    const bounds = objectBounds(object);
    if (pointInExpandedRect(point, bounds, tolerance)) return objectKey(object.id);
  }

  const strokes = state.listStrokes();
  for (let i = strokes.length - 1; i >= 0; i -= 1) {
    const stroke = strokes[i];
    if (distanceToStroke(point, stroke) <= tolerance + Number(stroke.width || 4) / 2) return strokeKey(stroke.id);
  }
  return null;
}

export function itemsIntersectingRect(state, rect) {
  const normalized = normalizeRect(rect);
  return allItemKeys(state).filter((key) => {
    const bounds = itemBounds(state, key);
    return bounds && rectsIntersect(normalized, bounds);
  });
}

export function combinedBounds(state, keys) {
  let result = null;
  for (const key of keys || []) {
    const bounds = itemBounds(state, key);
    if (!bounds) continue;
    if (!result) result = { ...bounds };
    else {
      const right = Math.max(result.x + result.width, bounds.x + bounds.width);
      const bottom = Math.max(result.y + result.height, bounds.y + bounds.height);
      result.x = Math.min(result.x, bounds.x);
      result.y = Math.min(result.y, bounds.y);
      result.width = right - result.x;
      result.height = bottom - result.y;
    }
  }
  return result;
}

export function normalizeRect(rect) {
  const x1 = Number(rect?.x1 ?? rect?.x ?? 0);
  const y1 = Number(rect?.y1 ?? rect?.y ?? 0);
  const x2 = Number(rect?.x2 ?? (x1 + Number(rect?.width || 0)));
  const y2 = Number(rect?.y2 ?? (y1 + Number(rect?.height || 0)));
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function rectsIntersect(a, b) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function pointInExpandedRect(point, rect, tolerance) {
  return point.x >= rect.x - tolerance
    && point.x <= rect.x + rect.width + tolerance
    && point.y >= rect.y - tolerance
    && point.y <= rect.y + rect.height + tolerance;
}

function distanceToStroke(point, stroke) {
  const points = stroke?.points || [];
  if (!points.length) return Infinity;
  if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) best = Math.min(best, pointToSegment(point, points[i], points[i + 1]));
  return best;
}

function pointToSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = point.x - a.x;
  const wy = point.y - a.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(point.x - b.x, point.y - b.y);
  const t = c1 / c2;
  return Math.hypot(point.x - (a.x + t * vx), point.y - (a.y + t * vy));
}
