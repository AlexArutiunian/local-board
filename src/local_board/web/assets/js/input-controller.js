import { createId } from "./id.js";
import { PencilEngine, isContactEvent } from "./pencil-engine.js";

export class InputController {
  constructor({ canvas, state, renderer, sendEvent, clientId, onStrokeFinished, selection = null }) {
    this.canvas = canvas;
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.clientId = clientId;
    this.selection = selection;

    this.tool = "pen";
    this.color = "#111111";
    this.width = 4;
    this.directInkEnabled = false;

    this.pencil = new PencilEngine({ state, renderer, sendEvent, clientId, onStrokeFinished });

    this.stylusPointerId = null;
    this.stylusMode = null;
    this.mousePointerId = null;
    this.mouseMode = null;
    this.touchPointers = new Map();
    this.panAnchor = null;
    this.pinchAnchor = null;
    this.erasedThisGesture = new Set();

    this.softPointerId = null;
    this.softPointerType = null;
    this.softMode = null;
    this.softLastPoint = null;

    this.selectionTouchPointerId = null;
    this.selectionTouchPoint = null;

    this.pendingStylusTouch = null;
    this.stylusFallbackTimer = null;
    this.bind();
  }

  bind() {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event), { passive: false });
    window.addEventListener("pointermove", (event) => this.onPointerMove(event), { capture: true, passive: false });
    window.addEventListener("pointerup", (event) => this.onPointerEnd(event), { capture: true, passive: false });
    window.addEventListener("pointercancel", (event) => this.onPointerEnd(event), { capture: true, passive: false });

    this.canvas.addEventListener("touchstart", (event) => this.onStylusTouchStart(event), { passive: false });
    window.addEventListener("touchmove", (event) => this.onStylusTouchMove(event), { capture: true, passive: false });
    window.addEventListener("touchend", (event) => this.onStylusTouchEnd(event), { capture: true, passive: false });
    window.addEventListener("touchcancel", (event) => this.onStylusTouchEnd(event), { capture: true, passive: false });

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
    if (tool === "pan") this.canvas.style.cursor = "grab";
    else if (tool === "eraser") this.canvas.style.cursor = "cell";
    else if (tool === "select") this.canvas.style.cursor = "default";
    else this.canvas.style.cursor = "crosshair";
  }

  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Number(width); }

  setDirectInkEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.directInkEnabled) return;
    this.directInkEnabled = next;
    if (!next) this.finishSoftInput({ endInk: true });
  }

  shouldSelect(event) {
    if (!this.selection) return false;
    if (event.pointerType === "mouse" && event.button === 2) return true;
    if (event.pointerType === "pen" && this.selection.selectedImage?.()) return false;
    if (this.selection.isCropping?.()) return event.pointerType !== "pen";
    return event.pointerType !== "touch"
      && (this.tool === "select" || event.ctrlKey || event.metaKey);
  }

  onPointerDown(event) {
    preventDefault(event);
    this.clearBrowserSelection();

    if (this.shouldSelect(event)) {
      this.cancelStylusFallback();
      this.cancelTouchGesture();
      this.endMouseInteraction();
      this.finishSoftInput({ endInk: true });
      this.pencil.interrupt();
      this.finishNonInkStylus();
      const forceMarquee = event.pointerType === "mouse" && event.button === 2 && !this.selection.isCropping?.();
      this.selection.pointerDown(event, { forceMarquee });
      return;
    }

    if (event.pointerType === "pen") {
      this.cancelStylusFallback();
      this.cancelTouchGesture();
      this.endMouseInteraction();
      this.finishSoftInput({ endInk: true });
      this.finishNonInkStylus();

      const effectiveTool = this.effectiveStylusTool();
      if (effectiveTool === "pen") {
        if (this.selection?.isCropping?.()) this.selection.cancelCrop();
        this.pencil.begin(event, { color: this.color, width: this.width, pointerType: "pen" });
      } else if (effectiveTool === "eraser" || effectiveTool === "pan") {
        this.pencil.interrupt();
        this.startNonInkStylus(event.pointerId, effectiveTool, event.clientX, event.clientY);
      }
      return;
    }

    if (event.pointerType === "touch") {
      if (this.isRealStylusActive()) return;

      if (this.selectionTouchPointerId !== null) {
        this.promoteSelectionTouchToNavigation(event);
        return;
      }

      if (this.softPointerType === "touch" && this.softPointerId !== null) {
        this.promoteSoftTouchToNavigation(event);
        return;
      }

      const selectedImage = this.selection?.selectedImage?.() || null;
      if (this.selection?.isCropping?.()) {
        if (selectedImage && pointInsideImage(this.renderer, selectedImage, event.clientX, event.clientY)) {
          this.beginCropTouch(event);
          return;
        }
        this.selection.cancelCrop();
        this.selection.clear();
      }

      // Direct finger ink is an explicit mode. When enabled, Pen/Eraser must win
      // even over an image so a student can annotate a pasted task directly.
      if (this.directInkEnabled && this.tool === "pen" && this.touchPointers.size === 0) {
        this.startSoftInk(event, "touch");
        return;
      }

      if (this.directInkEnabled && this.tool === "eraser" && this.touchPointers.size === 0) {
        this.startSoftErase(event);
        return;
      }

      if (!this.selection?.isCropping?.()) {
        const image = findImageAt(this.state, this.renderer, event.clientX, event.clientY);
        if (image) {
          this.beginImageTouch(event, image);
          return;
        }
        if (this.selection?.hasSelection?.()) this.selection.clear();
      }

      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.startTouchGesture();
      return;
    }

    if (this.isRealStylusActive()) return;
    if (event.button !== undefined && event.button !== 0) return;

    if (this.directInkEnabled && this.tool === "pen") {
      this.startSoftInk(event, "mouse");
      return;
    }

    this.mousePointerId = event.pointerId;
    if (this.tool === "eraser") {
      this.mouseMode = "eraser";
      this.erasedThisGesture.clear();
      this.eraseAt(event.clientX, event.clientY);
    } else {
      this.mouseMode = "pan";
      this.panAnchor = { x: event.clientX, y: event.clientY };
    }
  }

  onPointerMove(event) {
    if (this.selection?.ownsPointer(event.pointerId)) {
      preventDefault(event);
      if (this.selectionTouchPointerId === event.pointerId) {
        this.selectionTouchPoint = { x: event.clientX, y: event.clientY };
      }
      this.selection.pointerMove(event);
      return;
    }

    if (this.pencil.ownsPointer(event.pointerId)) {
      preventDefault(event);
      if (this.softPointerId === event.pointerId) this.softLastPoint = { x: event.clientX, y: event.clientY };
      this.pencil.move(event);
      return;
    }

    if (this.softPointerId === event.pointerId && this.softMode === "eraser") {
      preventDefault(event);
      this.softLastPoint = { x: event.clientX, y: event.clientY };
      this.eraseAt(event.clientX, event.clientY);
      return;
    }

    if (event.pointerType === "pen" && isContactEvent(event)) {
      preventDefault(event);
      this.cancelStylusFallback();
      this.cancelTouchGesture();
      this.endMouseInteraction();
      this.finishSoftInput({ endInk: true });
      this.finishNonInkStylus();

      const effectiveTool = this.effectiveStylusTool();
      if (effectiveTool === "select" && this.selection) {
        this.selection.pointerDown(event);
      } else if (effectiveTool === "pen") {
        if (this.selection?.isCropping?.()) this.selection.cancelCrop();
        this.pencil.recover(event, { color: this.color, width: this.width });
      } else if (effectiveTool === "eraser" || effectiveTool === "pan") {
        this.pencil.interrupt();
        this.startNonInkStylus(event.pointerId, effectiveTool, event.clientX, event.clientY);
      }
      return;
    }

    if (this.stylusPointerId === event.pointerId) {
      preventDefault(event);
      if (!isContactEvent(event)) {
        this.finishNonInkStylus();
        return;
      }
      if (this.stylusMode === "eraser") this.eraseAt(event.clientX, event.clientY);
      else if (this.stylusMode === "pan") this.movePan(event.clientX, event.clientY);
      return;
    }

    if (this.touchPointers.has(event.pointerId)) {
      preventDefault(event);
      if (this.isRealStylusActive()) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.moveTouchGesture();
      return;
    }

    if (this.mousePointerId === event.pointerId) {
      preventDefault(event);
      if (this.mouseMode === "eraser") this.eraseAt(event.clientX, event.clientY);
      else this.movePan(event.clientX, event.clientY);
    }
  }

  onPointerEnd(event) {
    if (this.selection?.ownsPointer(event.pointerId)) {
      preventDefault(event);
      this.selection.pointerUp(event);
      if (this.selectionTouchPointerId === event.pointerId) this.clearSelectionTouchTracking();
      return;
    }

    if (this.pencil.ownsPointer(event.pointerId)) {
      preventDefault(event);
      this.pencil.end(event.pointerId);
      if (this.softPointerId === event.pointerId) this.clearSoftTracking();
      return;
    }

    if (this.softPointerId === event.pointerId && this.softMode === "eraser") {
      preventDefault(event);
      this.clearSoftTracking();
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
      const shouldSaveView = this.mouseMode === "pan";
      this.endMouseInteraction();
      if (shouldSaveView) this.renderer.saveView();
    }
  }

  effectiveStylusTool() {
    if (this.tool === "select" && this.selection?.selectedImage?.()) return "pen";
    return this.tool;
  }

  beginImageTouch(event, image) {
    this.cancelStylusFallback();
    this.cancelTouchGesture();
    this.endMouseInteraction();
    this.finishSoftInput({ endInk: true });

    const key = `object:${image.id}`;
    this.selection.selectOnly(key);
    const world = this.renderer.screenToWorld(event.clientX, event.clientY);
    this.selection.preparePointer(event, world);
    this.selection.mode = this.selection.hitResizeHandle(event) ? "resize" : "pending-move";
    this.selection.captureOriginals();
    this.trackSelectionTouch(event);
  }

  beginCropTouch(event) {
    this.cancelStylusFallback();
    this.cancelTouchGesture();
    this.endMouseInteraction();
    this.finishSoftInput({ endInk: true });
    this.selection.pointerDown(event);
    if (this.selection.ownsPointer(event.pointerId)) this.trackSelectionTouch(event);
  }

  trackSelectionTouch(event) {
    this.selectionTouchPointerId = event.pointerId;
    this.selectionTouchPoint = { x: event.clientX, y: event.clientY };
  }

  promoteSelectionTouchToNavigation(secondEvent) {
    if (this.selectionTouchPointerId === null) return;
    const firstId = this.selectionTouchPointerId;
    const first = this.selectionTouchPoint || { x: secondEvent.clientX, y: secondEvent.clientY };
    this.selection?.cancelPointer();
    this.clearSelectionTouchTracking();
    this.touchPointers.set(firstId, { ...first });
    this.touchPointers.set(secondEvent.pointerId, { x: secondEvent.clientX, y: secondEvent.clientY });
    this.startTouchGesture();
  }

  clearSelectionTouchTracking() {
    this.selectionTouchPointerId = null;
    this.selectionTouchPoint = null;
  }

  startSoftInk(event, pointerType) {
    this.finishSoftInput({ endInk: true });
    this.softPointerId = event.pointerId;
    this.softPointerType = pointerType;
    this.softMode = "ink";
    this.softLastPoint = { x: event.clientX, y: event.clientY };
    this.pencil.begin(event, { color: this.color, width: this.width, pointerType });
  }

  startSoftErase(event) {
    this.finishSoftInput({ endInk: true });
    this.softPointerId = event.pointerId;
    this.softPointerType = "touch";
    this.softMode = "eraser";
    this.softLastPoint = { x: event.clientX, y: event.clientY };
    this.erasedThisGesture.clear();
    this.eraseAt(event.clientX, event.clientY);
  }

  promoteSoftTouchToNavigation(secondEvent) {
    if (this.softPointerType !== "touch" || this.softPointerId === null) return;
    const firstId = this.softPointerId;
    const first = this.softLastPoint || { x: secondEvent.clientX, y: secondEvent.clientY };
    if (this.softMode === "ink" && this.pencil.ownsPointer(firstId)) this.pencil.cancel(firstId);
    this.clearSoftTracking();
    this.touchPointers.set(firstId, { ...first });
    this.touchPointers.set(secondEvent.pointerId, { x: secondEvent.clientX, y: secondEvent.clientY });
    this.startTouchGesture();
  }

  finishSoftInput({ endInk = false } = {}) {
    if (endInk && this.softMode === "ink" && this.softPointerId !== null && this.pencil.ownsPointer(this.softPointerId)) {
      this.pencil.end(this.softPointerId);
    }
    this.clearSoftTracking();
  }

  clearSoftTracking() {
    this.softPointerId = null;
    this.softPointerType = null;
    this.softMode = null;
    this.softLastPoint = null;
    this.erasedThisGesture.clear();
  }

  onStylusTouchStart(event) {
    const touch = findStylusTouch(event.changedTouches);
    if (!touch) return;
    preventDefault(event);
    this.pendingStylusTouch = snapshotTouch(touch);
    this.cancelStylusFallbackTimer();
    this.stylusFallbackTimer = setTimeout(() => {
      this.stylusFallbackTimer = null;
      const pending = this.pendingStylusTouch;
      if (!pending || this.isRealStylusActive()) return;
      this.beginStylusTouchFallback(pending);
    }, 0);
  }

  onStylusTouchMove(event) {
    const touch = findStylusTouch(event.changedTouches) || findStylusTouch(event.touches);
    if (!touch) return;
    preventDefault(event);
    const adapted = touchToPointerLike(touch);
    const key = adapted.pointerId;

    if (this.selection?.ownsPointer(key)) {
      this.selection.pointerMove(adapted);
      return;
    }
    if (this.pencil.isActive() && !this.pencil.ownsPointer(key)) return;
    if (this.stylusPointerId !== null && this.stylusPointerId !== key) return;

    this.cancelStylusFallbackTimer();
    this.pendingStylusTouch = snapshotTouch(touch);

    if (this.pencil.ownsPointer(key)) {
      this.pencil.move(adapted);
      return;
    }
    if (this.stylusPointerId === key) {
      if (this.stylusMode === "eraser") this.eraseAt(touch.clientX, touch.clientY);
      else if (this.stylusMode === "pan") this.movePan(touch.clientX, touch.clientY);
      return;
    }
    this.beginStylusTouchFallback(this.pendingStylusTouch);
  }

  onStylusTouchEnd(event) {
    const touch = findStylusTouch(event.changedTouches);
    if (!touch) return;
    preventDefault(event);
    this.cancelStylusFallbackTimer();
    this.pendingStylusTouch = null;
    const key = touchKey(touch.identifier);

    if (this.selection?.ownsPointer(key)) {
      this.selection.pointerUp(touchToPointerLike(touch));
      return;
    }
    if (this.pencil.ownsPointer(key)) {
      this.pencil.end(key);
      return;
    }
    if (this.stylusPointerId === key) {
      const shouldSaveView = this.stylusMode === "pan";
      this.finishNonInkStylus();
      if (shouldSaveView) this.renderer.saveView();
      return;
    }
    if (this.pencil.isActive() && this.softPointerId === null) this.pencil.interrupt();
  }

  beginStylusTouchFallback(touchSnapshot) {
    if (!touchSnapshot || this.isRealStylusActive()) return;
    this.cancelTouchGesture();
    this.endMouseInteraction();
    this.finishSoftInput({ endInk: true });
    const adapted = touchToPointerLike(touchSnapshot);
    const effectiveTool = this.effectiveStylusTool();

    if (effectiveTool === "select" && this.selection) {
      this.selection.pointerDown(adapted);
    } else if (effectiveTool === "pen") {
      if (this.selection?.isCropping?.()) this.selection.cancelCrop();
      this.pencil.recover(adapted, { color: this.color, width: this.width });
    } else if (effectiveTool === "eraser" || effectiveTool === "pan") {
      this.startNonInkStylus(adapted.pointerId, effectiveTool, adapted.clientX, adapted.clientY);
    }
  }

  startNonInkStylus(pointerId, mode, clientX, clientY) {
    this.stylusPointerId = pointerId;
    this.stylusMode = mode;
    this.erasedThisGesture.clear();
    if (mode === "eraser") this.eraseAt(clientX, clientY);
    else this.panAnchor = { x: clientX, y: clientY };
  }

  isRealStylusActive() {
    const realPenInk = this.pencil.isActive() && this.softPointerId === null;
    return realPenInk || this.stylusPointerId !== null;
  }

  finishNonInkStylus() {
    this.stylusPointerId = null;
    this.stylusMode = null;
    this.erasedThisGesture.clear();
    this.panAnchor = null;
  }

  endMouseInteraction() {
    this.mousePointerId = null;
    this.mouseMode = null;
    this.erasedThisGesture.clear();
    if (!this.touchPointers.size) this.panAnchor = null;
  }

  startTouchGesture() {
    if (this.touchPointers.size === 1) {
      const point = [...this.touchPointers.values()][0];
      this.panAnchor = { x: point.x, y: point.y };
      this.pinchAnchor = null;
    } else if (this.touchPointers.size >= 2) {
      const [a, b] = [...this.touchPointers.values()];
      this.pinchAnchor = { distance: distance(a, b), zoom: this.renderer.view.zoom };
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
      if (!this.pinchAnchor) this.pinchAnchor = { distance: currentDistance, zoom: this.renderer.view.zoom };
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

  cancelStylusFallbackTimer() {
    if (this.stylusFallbackTimer === null) return;
    clearTimeout(this.stylusFallbackTimer);
    this.stylusFallbackTimer = null;
  }

  cancelStylusFallback() {
    this.cancelStylusFallbackTimer();
    this.pendingStylusTouch = null;
  }

  interruptInput() {
    const hadNavigation = this.touchPointers.size > 0
      || (this.mousePointerId !== null && this.mouseMode === "pan")
      || (this.stylusPointerId !== null && this.stylusMode === "pan");
    this.cancelStylusFallback();
    this.finishSoftInput({ endInk: true });
    this.pencil.interrupt();
    this.selection?.cancelPointer();
    this.clearSelectionTouchTracking();
    this.finishNonInkStylus();
    this.touchPointers.clear();
    this.mousePointerId = null;
    this.mouseMode = null;
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
    const mutation = { type: "stroke.delete", op_id: createId(), stroke_id: hit.id };
    this.state.applyEvent(mutation, null, this.clientId);
    this.sendEvent(mutation);
    this.renderer.requestRender();
  }

  clearBrowserSelection() {
    try { window.getSelection?.()?.removeAllRanges(); } catch (_) {}
  }
}

function preventDefault(event) { if (event.cancelable) event.preventDefault(); }

function findStylusTouch(touchList) {
  if (!touchList) return null;
  for (const touch of Array.from(touchList)) if (touch.touchType === "stylus") return touch;
  return null;
}

function snapshotTouch(touch) {
  return {
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    force: Number(touch.force || 0.45),
    touchType: "stylus",
  };
}

function touchToPointerLike(touch) {
  return {
    pointerId: touchKey(touch.identifier),
    pointerType: "pen",
    clientX: touch.clientX,
    clientY: touch.clientY,
    pressure: Number(touch.force || 0.45),
    force: Number(touch.force || 0.45),
    buttons: 1,
  };
}

function touchKey(identifier) { return `stylus-touch:${identifier}`; }

function findImageAt(state, renderer, clientX, clientY) {
  const point = renderer.screenToWorld(clientX, clientY);
  const tolerance = 4 / Math.max(0.2, renderer.view.zoom);
  const objects = state.listObjects();
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (object.kind !== "image") continue;
    if (point.x >= object.x - tolerance
      && point.x <= object.x + object.width + tolerance
      && point.y >= object.y - tolerance
      && point.y <= object.y + object.height + tolerance) return object;
  }
  return null;
}

function pointInsideImage(renderer, object, clientX, clientY) {
  const point = renderer.screenToWorld(clientX, clientY);
  return point.x >= object.x
    && point.x <= object.x + object.width
    && point.y >= object.y
    && point.y <= object.y + object.height;
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
