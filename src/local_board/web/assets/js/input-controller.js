import { cloneStroke } from "./board-state.js";
import { createId } from "./id.js";

export class InputController {
  constructor({ canvas, state, renderer, sendEvent, clientId, onStrokeFinished }) {
    this.canvas = canvas;
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.clientId = clientId;
    this.onStrokeFinished = onStrokeFinished;

    this.tool = "pen";
    this.color = "#111111";
    this.width = 4;
    this.activePointerId = null;
    this.currentStrokeId = null;
    this.touchPointers = new Map();
    this.panAnchor = null;
    this.pinchAnchor = null;
    this.erasedThisGesture = new Set();

    this.bind();
  }

  bind() {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerEnd(event));
    this.canvas.addEventListener("pointercancel", (event) => this.onPointerEnd(event));
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.style.cursor = tool === "pan" ? "grab" : tool === "eraser" ? "cell" : "crosshair";
  }

  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Number(width); }

  onPointerDown(event) {
    event.preventDefault();
    this.canvas.setPointerCapture?.(event.pointerId);

    // Finger/palm input is navigation only. Never allow it to create or erase ink.
    if (event.pointerType === "touch") {
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.startTouchGesture();
      return;
    }

    // Drawing is deliberately allow-listed to a real stylus. This is stricter than
    // merely rejecting `touch`: mouse-like or misclassified palm events cannot ink.
    if (!this.isStylus(event)) {
      this.startPan(event);
      return;
    }

    if (this.tool === "pan") {
      this.startPan(event);
    } else if (this.tool === "eraser") {
      this.activePointerId = event.pointerId;
      this.erasedThisGesture.clear();
      this.eraseAt(event.clientX, event.clientY);
    } else {
      this.startStroke(event);
    }
  }

  onPointerMove(event) {
    event.preventDefault();

    if (event.pointerType === "touch" && this.touchPointers.has(event.pointerId)) {
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.moveTouchGesture();
      return;
    }

    if (this.activePointerId !== event.pointerId) return;

    // Non-stylus pointers are navigation-only even while the pen/eraser tool is active.
    if (!this.isStylus(event)) {
      this.movePan(event);
      return;
    }

    if (this.tool === "pan") {
      this.movePan(event);
      return;
    }

    if (this.tool === "eraser") {
      this.eraseAt(event.clientX, event.clientY);
      return;
    }

    if (this.currentStrokeId) {
      const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
      const points = samples
        .filter((sample) => this.isStylus(sample))
        .map((sample) => this.eventPoint(sample));
      if (!points.length) return;
      const mutation = this.withOp({ type: "stroke.append", stroke_id: this.currentStrokeId, points });
      this.state.applyEvent(mutation, null, this.clientId);
      this.sendEvent(mutation);
      this.renderer.render();
    }
  }

  onPointerEnd(event) {
    if (event.pointerType === "touch") {
      this.touchPointers.delete(event.pointerId);
      this.resetTouchAnchors();
      this.renderer.saveView();
      return;
    }

    if (this.currentStrokeId && this.activePointerId === event.pointerId && this.isStylus(event)) {
      const strokeId = this.currentStrokeId;
      const mutation = this.withOp({ type: "stroke.end", stroke_id: strokeId });
      this.state.applyEvent(mutation, null, this.clientId);
      this.sendEvent(mutation);
      const finished = this.state.getStroke(strokeId);
      if (finished) this.onStrokeFinished(cloneStroke(finished));
      this.currentStrokeId = null;
      this.renderer.render();
    }

    if (this.activePointerId === event.pointerId) {
      this.activePointerId = null;
      this.panAnchor = null;
      this.erasedThisGesture.clear();
      this.renderer.saveView();
    }
  }

  isStylus(event) {
    return event.pointerType === "pen";
  }

  startStroke(event) {
    if (!this.isStylus(event)) return;

    this.activePointerId = event.pointerId;
    this.currentStrokeId = createId();
    const stroke = {
      id: this.currentStrokeId,
      color: this.color,
      width: this.width,
      pointer_type: "pen",
      points: [this.eventPoint(event)],
    };
    const mutation = this.withOp({ type: "stroke.begin", stroke });
    this.state.applyEvent(mutation, null, this.clientId);
    this.sendEvent(mutation);
    this.renderer.render();
  }

  startPan(event) {
    this.activePointerId = event.pointerId;
    this.panAnchor = { x: event.clientX, y: event.clientY };
  }

  movePan(event) {
    if (!this.panAnchor) return;
    const dx = event.clientX - this.panAnchor.x;
    const dy = event.clientY - this.panAnchor.y;
    this.panAnchor = { x: event.clientX, y: event.clientY };
    this.renderer.panBy(dx, dy);
  }

  startTouchGesture() {
    if (this.touchPointers.size === 1) {
      const point = [...this.touchPointers.values()][0];
      this.panAnchor = { x: point.x, y: point.y };
      this.pinchAnchor = null;
    } else if (this.touchPointers.size >= 2) {
      const [a, b] = [...this.touchPointers.values()];
      const center = midpoint(a, b);
      this.pinchAnchor = {
        distance: distance(a, b),
        zoom: this.renderer.view.zoom,
        center,
      };
      this.panAnchor = null;
    }
  }

  moveTouchGesture() {
    if (this.touchPointers.size === 1) {
      const point = [...this.touchPointers.values()][0];
      if (!this.panAnchor) this.panAnchor = { x: point.x, y: point.y };
      const dx = point.x - this.panAnchor.x;
      const dy = point.y - this.panAnchor.y;
      this.panAnchor = { x: point.x, y: point.y };
      this.renderer.panBy(dx, dy);
      return;
    }

    if (this.touchPointers.size >= 2) {
      const [a, b] = [...this.touchPointers.values()];
      const center = midpoint(a, b);
      const currentDistance = distance(a, b);
      if (!this.pinchAnchor) {
        this.pinchAnchor = { distance: currentDistance, zoom: this.renderer.view.zoom, center };
      }
      const newZoom = this.pinchAnchor.zoom * (currentDistance / Math.max(1, this.pinchAnchor.distance));
      this.renderer.zoomAt(center.x, center.y, newZoom);
    }
  }

  resetTouchAnchors() {
    this.panAnchor = null;
    this.pinchAnchor = null;
    if (this.touchPointers.size) this.startTouchGesture();
  }

  onWheel(event) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.renderer.zoomAt(event.clientX, event.clientY, this.renderer.view.zoom * factor);
    this.renderer.saveView();
  }

  eraseAt(clientX, clientY) {
    const point = this.renderer.screenToWorld(clientX, clientY);
    const hit = findClosestStroke(this.state.listStrokes(), point, 18 / this.renderer.view.zoom, this.erasedThisGesture);
    if (!hit) return;
    this.erasedThisGesture.add(hit.id);
    const mutation = this.withOp({ type: "stroke.delete", stroke_id: hit.id });
    this.state.applyEvent(mutation, null, this.clientId);
    this.sendEvent(mutation);
    this.renderer.render();
  }

  eventPoint(event) {
    const point = this.renderer.screenToWorld(event.clientX, event.clientY);
    return {
      x: point.x,
      y: point.y,
      pressure: event.pressure || 0.45,
    };
  }

  withOp(event) {
    return { ...event, op_id: createId() };
  }
}

function findClosestStroke(strokes, point, radius, ignored) {
  let best = null;
  let bestDistance = Infinity;
  for (let i = strokes.length - 1; i >= 0; i -= 1) {
    const stroke = strokes[i];
    if (ignored.has(stroke.id)) continue;
    const points = stroke.points || [];
    if (!points.length) continue;
    let distanceToStroke = Infinity;
    if (points.length === 1) {
      distanceToStroke = Math.hypot(point.x - points[0].x, point.y - points[0].y);
    } else {
      for (let j = 0; j < points.length - 1; j += 1) {
        distanceToStroke = Math.min(distanceToStroke, pointToSegment(point, points[j], points[j + 1]));
      }
    }
    if (distanceToStroke < bestDistance) {
      bestDistance = distanceToStroke;
      best = stroke;
    }
  }
  return bestDistance <= radius ? best : null;
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

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
