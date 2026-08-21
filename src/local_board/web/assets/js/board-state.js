export class BoardState {
  constructor() {
    this.strokes = new Map();
    this.order = [];
    this.revision = 0;
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
  }

  applyEvent(event, revision = null, actorId = null) {
    if (!event) return;
    const type = event.type;

    if (type === "stroke.begin" || type === "stroke.restore") {
      const stroke = cloneStroke(event.stroke);
      stroke.author_id = actorId || stroke.author_id || "local";
      stroke.complete = type === "stroke.restore";
      this.strokes.set(stroke.id, stroke);
      if (!this.order.includes(stroke.id)) this.order.push(stroke.id);
    } else if (type === "stroke.append") {
      const stroke = this.strokes.get(event.stroke_id);
      if (stroke) stroke.points.push(...event.points.map(clonePoint));
    } else if (type === "stroke.end") {
      const stroke = this.strokes.get(event.stroke_id);
      if (stroke) stroke.complete = true;
    } else if (type === "stroke.delete") {
      this.strokes.delete(event.stroke_id);
      this.order = this.order.filter((id) => id !== event.stroke_id);
    } else if (type === "board.clear") {
      this.strokes.clear();
      this.order = [];
    }

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
  return {
    id: String(stroke.id),
    author_id: stroke.author_id ? String(stroke.author_id) : undefined,
    color: String(stroke.color || "#111111"),
    width: Number(stroke.width || 4),
    pointer_type: String(stroke.pointer_type || "pen"),
    points: (stroke.points || []).map(clonePoint),
    complete: Boolean(stroke.complete),
  };
}
