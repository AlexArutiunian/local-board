export class BoardState {
  constructor() {
    this.strokes = new Map();
    this.order = [];
    this.revision = 0;
    this.baseGeneration = 0;
  }

  applySnapshot(board) {
    this.strokes.clear();
    this.order = [];
    this.revision = Number(board?.revision || 0);
    for (const raw of board?.strokes || []) {
      const stroke = cloneStroke(raw);
      this.strokes.set(stroke.id, stroke);
      this.order.push(stroke.id);
    }
    this.baseGeneration += 1;
  }

  applyEvent(event, revision = null, actorId = null) {
    if (!event) return;
    const type = event.type;
    let completedLayerChanged = false;

    if (type === "stroke.begin" || type === "stroke.restore") {
      const stroke = cloneStroke(event.stroke);
      stroke.author_id = actorId || stroke.author_id || "local";
      stroke.complete = type === "stroke.restore";
      this.strokes.set(stroke.id, stroke);
      if (!this.order.includes(stroke.id)) this.order.push(stroke.id);
      completedLayerChanged = type === "stroke.restore";
    } else if (type === "stroke.append") {
      const stroke = this.strokes.get(event.stroke_id);
      if (stroke) stroke.points.push(...event.points.map(clonePoint));
    } else if (type === "stroke.end") {
      const stroke = this.strokes.get(event.stroke_id);
      if (stroke && !stroke.complete) {
        stroke.complete = true;
        completedLayerChanged = true;
      }
    } else if (type === "stroke.delete") {
      if (this.strokes.has(event.stroke_id)) completedLayerChanged = true;
      this.strokes.delete(event.stroke_id);
      this.order = this.order.filter((id) => id !== event.stroke_id);
    } else if (type === "board.clear") {
      completedLayerChanged = this.strokes.size > 0;
      this.strokes.clear();
      this.order = [];
    }

    if (completedLayerChanged) this.baseGeneration += 1;
    if (revision !== null) this.revision = Math.max(this.revision, Number(revision) || 0);
  }

  listStrokes() {
    return this.order.map((id) => this.strokes.get(id)).filter(Boolean);
  }

  getStroke(id) {
    return this.strokes.get(id) || null;
  }

  hasStroke(id) {
    return this.strokes.has(id);
  }
}

export function clonePoint(point) {
  return {
    x: Number(point.x),
    y: Number(point.y),
    pressure: Number(point.pressure ?? 0.5),
  };
}

export function cloneStroke(stroke) {
  const sourceZoom = Number(stroke.source_zoom);
  return {
    id: String(stroke.id),
    author_id: stroke.author_id ? String(stroke.author_id) : undefined,
    color: String(stroke.color || "#111111"),
    width: Number(stroke.width || 4),
    pointer_type: String(stroke.pointer_type || "pen"),
    source_zoom: Number.isFinite(sourceZoom) ? sourceZoom : undefined,
    points: (stroke.points || []).map(clonePoint),
    complete: Boolean(stroke.complete),
  };
}
