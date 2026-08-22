import { createId } from "./id.js";
import { PencilEngine } from "./pencil-engine.js";

export class InputController {
  constructor({ canvas, state, renderer, sendEvent, clientId, onStrokeFinished }) {
    this.canvas = canvas;
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.clientId = clientId;

    this.tool = "pen";
    this.color = "#111111";
    this.width = 4;

    this.pencil = new PencilEngine({
      state,
      renderer,
      sendEvent,
      clientId,
      onStrokeFinished,
    });

    this.stylusPointerId = null;
    this.stylusMode = null;
    this.mousePointerId = null;
    this.touchPointers = new Map();
    this.panAnchor = null;
    this.pinchAnchor = null;
    this.erasedThisGesture = new Set();

    this.bind();
  }

  bind() {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event), { passive: false });

    // Continue an already-started contact at window level. We deliberately avoid
    // explicit setPointerCapture/releasePointerCapture for Pencil: direct-manipulation
    // pointers have implicit capture semantics, while WebKit has historically had
    // edge cases around explicit capture transitions during rapid contacts.
    window.addEventListener("pointermove", (event) => this.onPointerMove(event), {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", (event) => this.onPointerEnd(event), {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointercancel", (event) => this.onPointerEnd(event), {
      capture: true,
      passive: false,
    });

    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

    for (const type of ["selectstart", "dragstart", "contextmenu"]) {
      this.canvas.addEventListener(type, (event) => event.preventDefault());
    }
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      this.canvas.addEventListener(type, (event) => event.preventDefault(), { passive: false });
    }

    window.addEventListener("blur", () => this.interruptInput());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.interruptInput();
    });
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.style.cursor = tool === "pan" ? "grab" : tool === "eraser" ? "cell" : "crosshair";
  }

  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Number(width); }

  onPointerDown(event) {
    preventDefault(event);
    this.clearBrowserSelection();

    if (event.pointerType === "pen") {
      // A fresh Pencil contact is authoritative. Any stale prior stylus state is
      // closed immediately rather than forcing the user to wait/retry the next letter.
      this.cancelTouchGesture();
      this.endMousePan();
      this.finishNonInkStylus();

      if (this.tool === "pen") {
        this.pencil.begin(event, { color: this.color, width: this.width });
      } else {
        this.pencil.interrupt();
        this.stylusPointerId = event.pointerId;
        this.stylusMode = this.tool;
        this.erasedThisGesture.clear();
        if (this.stylusMode === "eraser") this.eraseAt(event.clientX, event.clientY);
        else this.panAnchor = { x: event.clientX, y: event.clientY };
      }
      return;
    }

    if (event.pointerType === "touch") {
      if (this.isStylusActive()) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.startTouchGesture();
      return;
    }

    // Mouse/trackpad are navigation-only and never create ink.
    if (this.isStylusActive()) return;
    if (event.button !== undefined && event.button !== 0) return;
    this.mousePointerId = event.pointerId;
    this.panAnchor = { x: event.clientX, y: event.clientY };
  }

  onPointerMove(event) {
    if (this.pencil.ownsPointer(event.pointerId)) {
      preventDefault(event);
      this.pencil.move(event);
      return;
    }

    if (this.stylusPointerId === event.pointerId) {
      preventDefault(event);
      if (event.buttons === 0 && Number(event.pressure || 0) === 0) {
        this.finishNonInkStylus();
        return;
      }
      if (this.stylusMode === "eraser") this.eraseAt(event.clientX, event.clientY);
      else if (this.stylusMode === "pan") this.movePan(event.clientX, event.clientY);
      return;
    }

    if (this.touchPointers.has(event.pointerId)) {
      preventDefault(event);
      if (this.isStylusActive()) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.moveTouchGesture();
      return;
    }

    if (this.mousePointerId === event.pointerId) {
      preventDefault(event);
      this.movePan(event.clientX, event.clientY);
    }
  }

  onPointerEnd(event) {
    // Pointer identity wins over the pointerType reported on the terminal event.
    // This makes cleanup robust even if WebKit metadata is odd during rapid lifts.
    if (this.pencil.ownsPointer(event.pointerId)) {
      preventDefault(event);
      this.pencil.end(event.pointerId);
      return;
    }

    if (this.stylusPointerId === event.pointerId) {
      preventDefault(event);
      const shouldSaveView = this.stylusMode === "pan";
      this.finishNonInkStylus();
      if (shouldSaveView) this.renderer.saveView();
      return;
    }

    if (this.touchPointers.has(event.pointerId)) {
      preventDefault(event);
      this.touchPointers.delete(event.pointerId);
      this.resetTouchAnchors();
      if (!this.touchPointers.size) this.renderer.saveView();
      return;
    }

    if (this.mousePointerId === event.pointerId) {
      preventDefault(event);
      this.endMousePan();
      this.renderer.saveView();
    }
  }

  isStylusActive() {
    return this.pencil.isActive() || this.stylusPointerId !== null;
  }

  finishNonInkStylus() {
    this.stylusPointerId = null;
    this.stylusMode = null;
    this.erasedThisGesture.clear();
    this.panAnchor = null;
  }

  endMousePan() {
    this.mousePointerId = null;
    if (!this.touchPointers.size) this.panAnchor = null;
  }

  startTouchGesture() {
    if (this.touchPointers.size === 1) {
      const point = [...this.touchPointers.values()][0];
      this.panAnchor = { x: point.x, y: point.y };
      this.pinchAnchor = null;
    } else if (this.touchPointers.size >= 2) {
      const [a, b] = [...this.touchPointers.values()];
      this.pinchAnchor = {
        distance: distance(a, b),
        zoom: this.renderer.view.zoom,
      };
      this.panAnchor = null;
    }
  }

  moveTouchGesture() {
    if (this.touchPointers.size === 1) {
      const point = [...this.touchPointers.values()][0];
      if (!this.panAnchor) this.panAnchor = { x: point.x, y: point.y };
      this.movePan(point.x, point.y);
      return;
    }

    if (this.touchPointers.size >= 2) {
      const [a, b] = [...this.touchPointers.values()];
      const center = midpoint(a, b);
      const currentDistance = distance(a, b);
      if (!this.pinchAnchor) {
        this.pinchAnchor = { distance: currentDistance, zoom: this.renderer.view.zoom };
      }
      const newZoom = this.pinchAnchor.zoom * (currentDistance / Math.max(1, this.pinchAnchor.distance));
      this.renderer.zoomAt(center.x, center.y, newZoom);
    }
  }

  movePan(clientX, clientY) {
    if (!this.panAnchor) {
      this.panAnchor = { x: clientX, y: clientY };
      return;
    }
    const dx = clientX - this.panAnchor.x;
    const dy = clientY - this.panAnchor.y;
    this.panAnchor = { x: clientX, y: clientY };
    this.renderer.panBy(dx, dy);
  }

  cancelTouchGesture() {
    this.touchPointers.clear();
    this.pinchAnchor = null;
    if (this.mousePointerId === null) this.panAnchor = null;
  }

  resetTouchAnchors() {
    this.panAnchor = null;
    this.pinchAnchor = null;
    if (this.touchPointers.size) this.startTouchGesture();
  }

  interruptInput() {
    const hadNavigation = this.touchPointers.size > 0
      || this.mousePointerId !== null
      || (this.stylusPointerId !== null && this.stylusMode === "pan");

    this.pencil.interrupt();
    this.finishNonInkStylus();
    this.touchPointers.clear();
    this.mousePointerId = null;
    this.panAnchor = null;
    this.pinchAnchor = null;

    if (hadNavigation) this.renderer.saveView();
  }

  onWheel(event) {
    preventDefault(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.renderer.zoomAt(event.clientX, event.clientY, this.renderer.view.zoom * factor);
    this.renderer.saveView();
  }

  eraseAt(clientX, clientY) {
    const point = this.renderer.screenToWorld(clientX, clientY);
    const hit = findClosestStroke(
      this.state.listStrokes(),
      point,
      18 / this.renderer.view.zoom,
      this.erasedThisGesture,
    );
    if (!hit) return;

    this.erasedThisGesture.add(hit.id);
    const mutation = {
      type: "stroke.delete",
      op_id: createId(),
      stroke_id: hit.id,
    };
    this.state.applyEvent(mutation, null, this.clientId);
    this.sendEvent(mutation);
    this.renderer.requestRender();
  }

  clearBrowserSelection() {
    try {
      window.getSelection?.()?.removeAllRanges();
    } catch (_) {}
  }
}

function preventDefault(event) {
  if (event.cancelable) event.preventDefault();
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

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
