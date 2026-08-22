export class BoardState {
  constructor() {
    this.strokes = new Map();
    this.order = [];
    this.objects = new Map();
    this.objectOrder = [];
    this.revision = 0;
    this.baseGeneration = 0;
  }

  applySnapshot(board) {
    this.strokes.clear();
    this.order = [];
    this.objects.clear();
    this.objectOrder = [];
    this.revision = Number(board?.revision || 0);
    for (const raw of board?.strokes || []) {
      const stroke = cloneStroke(raw);
      this.strokes.set(stroke.id, stroke);
      this.order.push(stroke.id);
    }
    for (const raw of board?.objects || []) {
      const object = cloneBoardObject(raw);
      this.objects.set(object.id, object);
      this.objectOrder.push(object.id);
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
    } else if (type === "stroke.translate") {
      completedLayerChanged = this.translateStroke(event.stroke_id, event.dx, event.dy, false);
    } else if (type === "stroke.delete") {
      if (this.strokes.has(event.stroke_id)) completedLayerChanged = true;
      this.strokes.delete(event.stroke_id);
      this.order = this.order.filter((id) => id !== event.stroke_id);
    } else if (type === "object.create") {
      const object = cloneBoardObject(event.object);
      object.author_id = actorId || object.author_id || "local";
      this.objects.set(object.id, object);
      if (!this.objectOrder.includes(object.id)) this.objectOrder.push(object.id);
      completedLayerChanged = true;
    } else if (type === "object.update") {
      completedLayerChanged = this.updateObject(event.object_id, event.patch, false);
    } else if (type === "object.delete") {
      if (this.objects.has(event.object_id)) completedLayerChanged = true;
      this.objects.delete(event.object_id);
      this.objectOrder = this.objectOrder.filter((id) => id !== event.object_id);
    } else if (type === "board.clear") {
      completedLayerChanged = this.strokes.size > 0 || this.objects.size > 0;
      this.strokes.clear();
      this.order = [];
      this.objects.clear();
      this.objectOrder = [];
    }

    if (completedLayerChanged) this.baseGeneration += 1;
    if (revision !== null) this.revision = Math.max(this.revision, Number(revision) || 0);
  }

  translateStroke(id, dx, dy, touchGeneration = true) {
    const stroke = this.strokes.get(id);
    if (!stroke) return false;
    const offsetX = Number(dx) || 0;
    const offsetY = Number(dy) || 0;
    for (const point of stroke.points) {
      point.x += offsetX;
      point.y += offsetY;
    }
    if (touchGeneration) this.baseGeneration += 1;
    return true;
  }

  updateObject(id, patch, touchGeneration = true) {
    const object = this.objects.get(id);
    if (!object) return false;
    for (const key of ["x", "y", "width", "height"]) {
      if (patch?.[key] !== undefined && Number.isFinite(Number(patch[key]))) object[key] = Number(patch[key]);
    }
    if (touchGeneration) this.baseGeneration += 1;
    return true;
  }

  listStrokes() { return this.order.map((id) => this.strokes.get(id)).filter(Boolean); }
  listObjects() { return this.objectOrder.map((id) => this.objects.get(id)).filter(Boolean); }
  getStroke(id) { return this.strokes.get(id) || null; }
  getObject(id) { return this.objects.get(id) || null; }
  hasStroke(id) { return this.strokes.has(id); }
  hasObject(id) { return this.objects.has(id); }
}

export function clonePoint(point) {
  return { x: Number(point.x), y: Number(point.y), pressure: Number(point.pressure ?? 0.5) };
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

export function cloneBoardObject(object) {
  return {
    id: String(object.id),
    author_id: object.author_id ? String(object.author_id) : undefined,
    kind: String(object.kind || "image"),
    x: Number(object.x || 0),
    y: Number(object.y || 0),
    width: Number(object.width || 320),
    height: Number(object.height || 240),
    src: String(object.src || ""),
    name: String(object.name || "image"),
  };
}
