import {
  allItemKeys,
  combinedBounds,
  hitTest,
  itemsIntersectingRect,
  objectKey,
  parseItemKey,
} from "./board-geometry.js";
import { createId } from "./id.js";

export class SelectionController {
  constructor({ canvas, state, renderer, sendEvent, clientId, onSelectionChange }) {
    this.canvas = canvas;
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.clientId = clientId;
    this.onSelectionChange = onSelectionChange;
    this.selected = new Set();
    this.activePointerId = null;
    this.activePointerType = null;
    this.requiredButtonMask = 0;
    this.mode = null;
    this.anchor = null;
    this.originals = new Map();
    this.lastDelta = { dx: 0, dy: 0 };
    this.marqueeAdditive = false;

    this.cropObjectId = null;
    this.cropRect = null;
    this.cropOriginalRect = null;
    this.bindRightMouseShortcut();
    this.bindKeyboard();
  }

  ownsPointer(pointerId) { return this.activePointerId === pointerId; }
  hasSelection() { return this.selected.size > 0; }
  keys() { return [...this.selected]; }
  isCropping() { return this.cropObjectId !== null && this.cropRect !== null; }

  setSelection(keys) {
    const next = new Set((keys || []).filter((key) => this.itemExists(key)));
    if (this.isCropping() && !next.has(objectKey(this.cropObjectId))) this.clearCropState();
    this.selected = next;
    this.renderer.setSelection(this.selected);
    this.notifySelection();
  }

  selectOnly(key) { this.setSelection(key ? [key] : []); }
  clear() { this.setSelection([]); }
  selectAll() { this.setSelection(allItemKeys(this.state)); }

  startCrop() {
    if (this.selected.size !== 1) return false;
    const parsed = parseItemKey([...this.selected][0]);
    if (parsed?.kind !== "object") return false;
    const object = this.state.getObject(parsed.id);
    if (!object || object.kind !== "image") return false;
    this.cancelPointer();
    this.cropObjectId = object.id;
    this.cropRect = { x: object.x, y: object.y, width: object.width, height: object.height };
    this.renderer.setCropOverlay({ objectId: object.id, rect: this.cropRect });
    this.notifySelection();
    return true;
  }

  applyCrop() {
    if (!this.isCropping()) return false;
    const object = this.state.getObject(this.cropObjectId);
    if (!object) {
      this.clearCropState();
      return false;
    }
    const patch = composeCropPatch(object, this.cropRect);
    const event = { type: "object.update", op_id: createId(), object_id: object.id, patch };
    this.state.applyEvent(event, null, this.clientId);
    this.sendEvent(event);
    this.clearCropState();
    this.renderer.invalidateBase();
    this.renderer.requestRender();
    this.notifySelection();
    return true;
  }

  cancelCrop() {
    if (!this.isCropping()) return false;
    this.cancelPointer();
    this.clearCropState();
    this.renderer.requestRender();
    this.notifySelection();
    return true;
  }

  pointerDown(event, { forceMarquee = false } = {}) {
    if (this.isCropping()) return this.cropPointerDown(event);

    const world = this.renderer.screenToWorld(event.clientX, event.clientY);
    const additive = Boolean(event.shiftKey);
    this.preparePointer(event, world);

    if (forceMarquee) {
      if (!additive) this.clear();
      this.startMarquee(world, additive);
      return true;
    }

    if (this.hitResizeHandle(event)) {
      this.mode = "resize";
      this.captureOriginals();
      return true;
    }

    const hit = hitTest(this.state, world, 9 / this.renderer.view.zoom);
    if (hit) {
      if (additive) {
        const next = new Set(this.selected);
        if (next.has(hit)) next.delete(hit);
        else next.add(hit);
        this.setSelection(next);
      } else if (!this.selected.has(hit)) {
        this.selectOnly(hit);
      }

      if (this.selected.has(hit)) {
        this.mode = "move";
        this.captureOriginals();
      } else {
        this.finishGestureState();
      }
      return true;
    }

    if (!additive) this.clear();
    this.startMarquee(world, additive);
    return true;
  }

  cropPointerDown(event) {
    const mode = this.cropHitMode(event);
    if (!mode) return true;
    const world = this.renderer.screenToWorld(event.clientX, event.clientY);
    this.preparePointer(event, world);
    this.mode = `crop:${mode}`;
    this.cropOriginalRect = { ...this.cropRect };
    return true;
  }

  preparePointer(event, world) {
    this.activePointerId = event.pointerId;
    this.activePointerType = event.pointerType || null;
    this.requiredButtonMask = this.activePointerType === "mouse" ? buttonMask(event.button) : 0;
    this.anchor = world;
    this.lastDelta = { dx: 0, dy: 0 };
    try { this.canvas.setPointerCapture?.(event.pointerId); } catch (_) {}
  }

  pointerMove(event) {
    if (!this.ownsPointer(event.pointerId) || !this.mode) return false;

    if (this.activePointerType === "mouse"
      && this.requiredButtonMask !== 0
      && (Number(event.buttons || 0) & this.requiredButtonMask) === 0) {
      this.pointerUp(event);
      return true;
    }

    const world = this.renderer.screenToWorld(event.clientX, event.clientY);

    if (this.mode === "marquee") {
      this.renderer.setMarquee({ x1: this.anchor.x, y1: this.anchor.y, x2: world.x, y2: world.y });
      return true;
    }

    const dx = world.x - this.anchor.x;
    const dy = world.y - this.anchor.y;
    this.lastDelta = { dx, dy };
    if (this.mode === "move") this.previewMove(dx, dy);
    else if (this.mode === "resize") this.previewResize(dx, dy);
    else if (this.mode.startsWith("crop:")) this.previewCrop(this.mode.slice(5), dx, dy);
    return true;
  }

  pointerUp(event) {
    if (!this.ownsPointer(event.pointerId)) return false;
    const mode = this.mode;

    if (mode === "marquee") {
      const world = this.renderer.screenToWorld(event.clientX, event.clientY);
      const hits = itemsIntersectingRect(this.state, {
        x1: this.anchor.x,
        y1: this.anchor.y,
        x2: world.x,
        y2: world.y,
      });
      const next = this.marqueeAdditive ? new Set([...this.selected, ...hits]) : new Set(hits);
      this.setSelection(next);
    } else if (mode === "move") {
      this.commitMove();
    } else if (mode === "resize") {
      this.commitResize();
    }

    this.renderer.setMarquee(null);
    this.releasePointerCapture(event.pointerId);
    this.finishGestureState();
    this.renderer.requestRender();
    return true;
  }

  cancelPointer() {
    const pointerId = this.activePointerId;
    if (this.mode === "move" || this.mode === "resize") this.restoreOriginals();
    if (this.mode?.startsWith("crop:") && this.cropOriginalRect) {
      this.cropRect = { ...this.cropOriginalRect };
      this.renderer.setCropOverlay({ objectId: this.cropObjectId, rect: this.cropRect });
    }
    this.renderer.setMarquee(null);
    this.releasePointerCapture(pointerId);
    this.finishGestureState();
    this.renderer.requestRender();
  }

  startMarquee(world, additive) {
    this.mode = "marquee";
    this.marqueeAdditive = additive;
    this.renderer.setMarquee({ x1: world.x, y1: world.y, x2: world.x, y2: world.y });
  }

  finishGestureState() {
    this.activePointerId = null;
    this.activePointerType = null;
    this.requiredButtonMask = 0;
    this.mode = null;
    this.anchor = null;
    this.originals.clear();
    this.lastDelta = { dx: 0, dy: 0 };
    this.marqueeAdditive = false;
    this.cropOriginalRect = null;
  }

  clearCropState() {
    this.cropObjectId = null;
    this.cropRect = null;
    this.cropOriginalRect = null;
    this.renderer.setCropOverlay(null);
  }

  bindRightMouseShortcut() {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (this.isCropping()) return;
      if (event.pointerType !== "mouse" || event.button !== 2) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (this.activePointerId !== null) this.cancelPointer();
      this.pointerDown(event, { forceMarquee: true });
      try { this.canvas.setPointerCapture?.(event.pointerId); } catch (_) {}
    }, { capture: true, passive: false });
  }

  releasePointerCapture(pointerId) {
    if (pointerId === null || pointerId === undefined) return;
    try {
      if (this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch (_) {}
  }

  deleteSelected() {
    if (!this.selected.size) return false;
    if (this.isCropping()) this.cancelCrop();
    for (const key of [...this.selected]) {
      const parsed = parseItemKey(key);
      if (!parsed) continue;
      let event;
      if (parsed.kind === "stroke") {
        event = { type: "stroke.delete", op_id: createId(), stroke_id: parsed.id };
      } else if (parsed.kind === "object") {
        event = { type: "object.delete", op_id: createId(), object_id: parsed.id };
      } else {
        continue;
      }
      this.state.applyEvent(event, null, this.clientId);
      this.sendEvent(event);
    }
    this.clear();
    this.renderer.requestRender();
    return true;
  }

  captureOriginals() {
    this.originals.clear();
    for (const key of this.selected) {
      const parsed = parseItemKey(key);
      if (parsed?.kind === "stroke") {
        const stroke = this.state.getStroke(parsed.id);
        if (stroke) this.originals.set(key, { points: stroke.points.map((point) => ({ ...point })) });
      } else if (parsed?.kind === "object") {
        const object = this.state.getObject(parsed.id);
        if (object) this.originals.set(key, { x: object.x, y: object.y, width: object.width, height: object.height });
      }
    }
  }

  previewMove(dx, dy) {
    let changed = false;
    for (const [key, original] of this.originals) {
      const parsed = parseItemKey(key);
      if (parsed?.kind === "stroke") {
        const stroke = this.state.getStroke(parsed.id);
        if (!stroke) continue;
        stroke.points = original.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
        changed = true;
      } else if (parsed?.kind === "object") {
        const object = this.state.getObject(parsed.id);
        if (!object) continue;
        object.x = original.x + dx;
        object.y = original.y + dy;
        changed = true;
      }
    }
    if (changed) this.touchBase();
  }

  previewResize(dx, dy) {
    if (this.selected.size !== 1) return;
    const key = [...this.selected][0];
    const parsed = parseItemKey(key);
    const original = this.originals.get(key);
    if (parsed?.kind !== "object" || !original) return;
    const object = this.state.getObject(parsed.id);
    if (!object) return;
    const ratio = original.width / Math.max(1, original.height);
    const widthScale = (original.width + dx) / original.width;
    const heightScale = (original.height + dy) / original.height;
    const scale = Math.max(0.12, widthScale, heightScale);
    object.width = Math.max(24, original.width * scale);
    object.height = Math.max(24 / ratio, object.width / ratio);
    this.touchBase();
  }

  previewCrop(handle, dx, dy) {
    const object = this.state.getObject(this.cropObjectId);
    const original = this.cropOriginalRect;
    if (!object || !original) return;
    const bounds = { x: object.x, y: object.y, width: object.width, height: object.height };
    const minSize = Math.max(8 / this.renderer.view.zoom, 2);
    let left = original.x;
    let top = original.y;
    let right = original.x + original.width;
    let bottom = original.y + original.height;
    const maxRight = bounds.x + bounds.width;
    const maxBottom = bounds.y + bounds.height;

    if (handle === "move") {
      const width = original.width;
      const height = original.height;
      left = clamp(original.x + dx, bounds.x, maxRight - width);
      top = clamp(original.y + dy, bounds.y, maxBottom - height);
      right = left + width;
      bottom = top + height;
    } else {
      if (handle.includes("w")) left = clamp(original.x + dx, bounds.x, right - minSize);
      if (handle.includes("e")) right = clamp(original.x + original.width + dx, left + minSize, maxRight);
      if (handle.includes("n")) top = clamp(original.y + dy, bounds.y, bottom - minSize);
      if (handle.includes("s")) bottom = clamp(original.y + original.height + dy, top + minSize, maxBottom);
    }

    this.cropRect = { x: left, y: top, width: right - left, height: bottom - top };
    this.renderer.setCropOverlay({ objectId: object.id, rect: this.cropRect });
  }

  cropHitMode(event) {
    if (!this.cropRect) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const start = this.renderer.worldToScreen(this.cropRect);
    const width = this.cropRect.width * this.renderer.view.zoom;
    const height = this.cropRect.height * this.renderer.view.zoom;
    const left = start.x;
    const top = start.y;
    const right = left + width;
    const bottom = top + height;
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;
    const threshold = event.pointerType === "touch" ? 22 : 13;
    const handles = [
      ["nw", left, top], ["n", midX, top], ["ne", right, top],
      ["e", right, midY], ["se", right, bottom], ["s", midX, bottom],
      ["sw", left, bottom], ["w", left, midY],
    ];
    for (const [name, x, y] of handles) {
      if (Math.hypot(px - x, py - y) <= threshold) return name;
    }
    if (px >= left && px <= right && py >= top && py <= bottom) return "move";
    return null;
  }

  restoreOriginals() {
    for (const [key, original] of this.originals) {
      const parsed = parseItemKey(key);
      if (parsed?.kind === "stroke") {
        const stroke = this.state.getStroke(parsed.id);
        if (stroke) stroke.points = original.points.map((point) => ({ ...point }));
      } else if (parsed?.kind === "object") {
        const object = this.state.getObject(parsed.id);
        if (object) Object.assign(object, original);
      }
    }
    this.touchBase();
  }

  commitMove() {
    const { dx, dy } = this.lastDelta;
    if (Math.hypot(dx, dy) < 0.01) return;
    for (const key of this.selected) {
      const parsed = parseItemKey(key);
      if (parsed?.kind === "stroke") {
        this.sendEvent({ type: "stroke.translate", op_id: createId(), stroke_id: parsed.id, dx, dy });
      } else if (parsed?.kind === "object") {
        const object = this.state.getObject(parsed.id);
        if (object) this.sendEvent({
          type: "object.update",
          op_id: createId(),
          object_id: parsed.id,
          patch: { x: object.x, y: object.y },
        });
      }
    }
  }

  commitResize() {
    if (this.selected.size !== 1) return;
    const parsed = parseItemKey([...this.selected][0]);
    if (parsed?.kind !== "object") return;
    const object = this.state.getObject(parsed.id);
    if (!object) return;
    this.sendEvent({
      type: "object.update",
      op_id: createId(),
      object_id: parsed.id,
      patch: { x: object.x, y: object.y, width: object.width, height: object.height },
    });
  }

  hitResizeHandle(event) {
    if (this.isCropping() || this.selected.size !== 1) return false;
    const key = [...this.selected][0];
    const parsed = parseItemKey(key);
    if (parsed?.kind !== "object") return false;
    const bounds = combinedBounds(this.state, this.selected);
    if (!bounds) return false;
    const handle = this.renderer.worldToScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
    const rect = this.canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return Math.hypot(sx - handle.x, sy - handle.y) <= 14;
  }

  touchBase() {
    this.state.baseGeneration += 1;
    this.renderer.invalidateBase();
    this.renderer.requestRender();
  }

  itemExists(key) {
    const parsed = parseItemKey(key);
    return parsed?.kind === "stroke"
      ? this.state.hasStroke(parsed.id)
      : parsed?.kind === "object"
        ? this.state.hasObject(parsed.id)
        : false;
  }

  notifySelection() { this.onSelectionChange?.(this.keys()); }

  bindKeyboard() {
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      if (event.key === "Escape") {
        if (this.isCropping()) this.cancelCrop();
        else {
          this.cancelPointer();
          this.clear();
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        this.selectAll();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && this.hasSelection() && !this.isCropping()) {
        event.preventDefault();
        this.deleteSelected();
      }
    });
  }
}

export function composeCropPatch(object, rect) {
  const width = Math.max(1e-6, Number(object.width));
  const height = Math.max(1e-6, Number(object.height));
  const localX = clamp((rect.x - object.x) / width, 0, 1);
  const localY = clamp((rect.y - object.y) / height, 0, 1);
  const localW = clamp(rect.width / width, 0.01, 1 - localX);
  const localH = clamp(rect.height / height, 0.01, 1 - localY);
  const baseX = Number(object.crop_x ?? 0);
  const baseY = Number(object.crop_y ?? 0);
  const baseW = Number(object.crop_width ?? 1);
  const baseH = Number(object.crop_height ?? 1);
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    crop_x: baseX + localX * baseW,
    crop_y: baseY + localY * baseH,
    crop_width: localW * baseW,
    crop_height: localH * baseH,
  };
}

function buttonMask(button) {
  if (button === 0) return 1;
  if (button === 1) return 4;
  if (button === 2) return 2;
  if (button === 3) return 8;
  if (button === 4) return 16;
  return 0;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export { objectKey };
