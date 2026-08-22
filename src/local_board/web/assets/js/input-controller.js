import { cloneStroke } from "./board-state.js";
import { createId } from "./id.js";

const MAX_NETWORK_BATCH_POINTS = 128;

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
    this.activePointerType = null;
    this.currentStrokeId = null;
    this.touchPointers = new Map();
    this.panAnchor = null;
    this.pinchAnchor = null;
    this.erasedThisGesture = new Set();
    this.pendingNetworkPoints = [];
    this.networkFlushHandle = null;

    this.bind();
  }

  bind() {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerEnd(event));
    this.canvas.addEventListener("pointercancel", (event) => this.onPointerEnd(event));
    this.canvas.addEventListener("lostpointercapture", (event) => this.onLostPointerCapture(event));
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

    // iPad Safari must never turn a Pencil gesture on the board into text selection,
    // a callout, drag, or browser gesture.
    for (const type of ["selectstart", "dragstart", "contextmenu"]) {
      this.canvas.addEventListener(type, (event) => event.preventDefault());
    }
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      this.canvas.addEventListener(type, (event) => event.preventDefault(), { passive: false });
    }
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.style.cursor = tool === "pan" ? "grab" : tool === "eraser" ? "cell" : "crosshair";
  }

  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Number(width); }

  onPointerDown(event) {
    event.preventDefault();
    this.clearBrowserSelection();

    if (event.pointerType === "touch") {
      if (this.isStylusActive()) return;
      this.capturePointer(event.pointerId);
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.startTouchGesture();
      return;
    }

    this.capturePointer(event.pointerId);

    if (this.isStylus(event)) {
      // Pencil always wins over a finger/palm gesture already touching the screen.
      this.cancelTouchGesture();
    }

    // Ink is strictly Pencil-only. Mouse-like or misclassified palm pointers can only pan.
    if (!this.isStylus(event)) {
      this.startPan(event);
      return;
    }

    if (this.tool === "pan") {
      this.startPan(event);
    } else if (this.tool === "eraser") {
      this.activePointerId = event.pointerId;
      this.activePointerType = "pen";
      this.erasedThisGesture.clear();
      this.eraseAt(event.clientX, event.clientY);
    } else {
      this.startStroke(event);
    }
  }

  onPointerMove(event) {
    event.preventDefault();

    if (event.pointerType === "touch") {
      if (this.isStylusActive()) return;
      if (!this.touchPointers.has(event.pointerId)) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.moveTouchGesture();
      return;
    }

    if (this.activePointerId !== event.pointerId) return;

    if (this.activePointerType !== "pen") {
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

    if (!this.currentStrokeId) return;

    // Safari can provide multiple high-frequency Pencil samples in one move event.
    // Apply all of them locally immediately, but batch network traffic once per frame.
    const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    const points = samples
      .filter((sample) => Number.isFinite(sample.clientX) && Number.isFinite(sample.clientY))
      .map((sample) => this.eventPoint(sample));
    if (!points.length) return;

    this.state.applyEvent(
      { type: "stroke.append", stroke_id: this.currentStrokeId, points },
      null,
      this.clientId,
    );
    this.pendingNetworkPoints.push(...points);
    this.scheduleNetworkFlush();
    this.renderer.requestRender();
  }

  onPointerEnd(event) {
    event.preventDefault();

    if (event.pointerType === "touch") {
      this.touchPointers.delete(event.pointerId);
      this.releasePointer(event.pointerId);
      this.resetTouchAnchors();
      if (!this.isStylusActive()) this.renderer.saveView();
      return;
    }

    this.finishActivePointer(event.pointerId);
  }

  onLostPointerCapture(event) {
    // Unexpected capture loss must never leave the controller in a stuck "Pencil down" state.
    if (this.activePointerId === event.pointerId) {
      this.finishActivePointer(event.pointerId, { releaseCapture: false });
    }
  }

  finishActivePointer(pointerId, { releaseCapture = true } = {}) {
    if (this.activePointerId !== pointerId) return;

    if (this.activePointerType === "pen" && this.currentStrokeId) {
      const strokeId = this.currentStrokeId;
      this.flushPendingStrokePoints();
      const mutation = this.withOp({ type: "stroke.end", stroke_id: strokeId });
      this.state.applyEvent(mutation, null, this.clientId);
      this.sendEvent(mutation);
      const finished = this.state.getStroke(strokeId);
      if (finished) this.onStrokeFinished(cloneStroke(finished));
      this.currentStrokeId = null;
      this.renderer.requestRender();
    }

    if (releaseCapture) this.releasePointer(pointerId);
    this.activePointerId = null;
    this.activePointerType = null;
    this.panAnchor = null;
    this.erasedThisGesture.clear();
    this.pendingNetworkPoints.length = 0;
    this.cancelScheduledNetworkFlush();
    this.renderer.saveView();
  }

  isStylus(event) {
    return event.pointerType === "pen";
  }

  isStylusActive() {
    return this.activePointerId !== null && this.activePointerType === "pen";
  }

  startStroke(event) {
    if (!this.isStylus(event)) return;

    this.activePointerId = event.pointerId;
    this.activePointerType = "pen";
    this.currentStrokeId = createId();
    this.pendingNetworkPoints.length = 0;
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
    this.renderer.requestRender();
  }

  startPan(event) {
    this.activePointerId = event.pointerId;
    this.activePointerType = event.pointerType || null;
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

  cancelTouchGesture() {
    for (const pointerId of this.touchPointers.keys()) this.releasePointer(pointerId);
    this.touchPointers.clear();
    this.panAnchor = null;
    this.pinchAnchor = null;
  }

  resetTouchAnchors() {
    this.panAnchor = null;
    this.pinchAnchor = null;
    if (this.touchPointers.size) this.startTouchGesture();
  }

  scheduleNetworkFlush() {
    if (this.networkFlushHandle !== null) return;
    this.networkFlushHandle = requestAnimationFrame(() => {
      this.networkFlushHandle = null;
      this.flushPendingStrokePoints();
    });
  }

  flushPendingStrokePoints() {
    if (!this.currentStrokeId || !this.pendingNetworkPoints.length) return;
    while (this.pendingNetworkPoints.length) {
      const points = this.pendingNetworkPoints.splice(0, MAX_NETWORK_BATCH_POINTS);
      this.sendEvent(this.withOp({
        type: "stroke.append",
        stroke_id: this.currentStrokeId,
        points,
      }));
    }
  }

  cancelScheduledNetworkFlush() {
    if (this.networkFlushHandle === null) return;
    cancelAnimationFrame(this.networkFlushHandle);
    this.networkFlushHandle = null;
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
    this.renderer.requestRender();
  }

  eventPoint(event) {
    const point = this.renderer.screenToWorld(event.clientX, event.clientY);
    const pressure = Number(event.pressure);
    return {
      x: point.x,
      y: point.y,
      pressure: Number.isFinite(pressure) && pressure > 0 ? pressure : 0.45,
    };
  }

  capturePointer(pointerId) {
    try {
      this.canvas.setPointerCapture?.(pointerId);
    } catch (_) {
      // Safari may reject capture during rapid pointer transitions; drawing still works.
    }
  }

  releasePointer(pointerId) {
    try {
      if (this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch (_) {}
  }

  clearBrowserSelection() {
    try {
      window.getSelection?.()?.removeAllRanges();
    } catch (_) {}
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
