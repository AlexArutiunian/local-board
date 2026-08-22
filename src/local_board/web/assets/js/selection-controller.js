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
    this.mode = null;
    this.anchor = null;
    this.originals = new Map();
    this.lastDelta = { dx: 0, dy: 0 };
    this.marqueeAdditive = false;
    this.bindKeyboard();
  }

  ownsPointer(pointerId) { return this.activePointerId === pointerId; }
  hasSelection() { return this.selected.size > 0; }
  keys() { return [...this.selected]; }

  setSelection(keys) {
    this.selected = new Set((keys || []).filter((key) => this.itemExists(key)));
    this.renderer.setSelection(this.selected);
    this.onSelectionChange?.(this.keys());
  }

  selectOnly(key) { this.setSelection(key ? [key] : []); }
  clear() { this.setSelection([]); }
  selectAll() { this.setSelection(allItemKeys(this.state)); }

  pointerDown(event) {
    const world = this.renderer.screenToWorld(event.clientX, event.clientY);
    const additive = Boolean(event.shiftKey);
    this.activePointerId = event.pointerId;
    this.anchor = world;
    this.lastDelta = { dx: 0, dy: 0 };

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
        this.mode = null;
        this.activePointerId = null;
      }
      return true;
    }

    if (!additive) this.clear();
    this.mode = "marquee";
    this.marqueeAdditive = additive;
    this.renderer.setMarquee({ x1: world.x, y1: world.y, x2: world.x, y2: world.y });
    return true;
  }

  pointerMove(event) {
    if (!this.ownsPointer(event.pointerId) || !this.mode) return false;
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
    return true;
  }

  pointerUp(event) {
    if (!this.ownsPointer(event.pointerId)) return false;
    const mode = this.mode;

    if (mode === "marquee") {
      const world = this.renderer.screenToWorld(event.clientX, event.clientY);
      const hits = itemsIntersectingRect(this.state, { x1: this.anchor.x, y1: this.anchor.y, x2: world.x, y2: world.y });
      const next = this.marqueeAdditive ? new Set([...this.selected, ...hits]) : new Set(hits);
      this.setSelection(next);
    } else if (mode === "move") {
      this.commitMove();
    } else if (mode === "resize") {
      this.commitResize();
    }

    this.renderer.setMarquee(null);
    this.activePointerId = null;
    this.mode = null;
    this.anchor = null;
    this.originals.clear();
    this.lastDelta = { dx: 0, dy: 0 };
    this.renderer.requestRender();
    return true;
  }

  cancelPointer() {
    if (this.mode === "move" || this.mode === "resize") this.restoreOriginals();
    this.renderer.setMarquee(null);
    this.activePointerId = null;
    this.mode = null;
    this.anchor = null;
    this.originals.clear();
    this.lastDelta = { dx: 0, dy: 0 };
  }

  deleteSelected() {
    if (!this.selected.size) return false;
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
        if (object) this.sendEvent({ type: "object.update", op_id: createId(), object_id: parsed.id, patch: { x: object.x, y: object.y } });
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
    if (this.selected.size !== 1) return false;
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
    return parsed?.kind === "stroke" ? this.state.hasStroke(parsed.id) : parsed?.kind === "object" ? this.state.hasObject(parsed.id) : false;
  }

  bindKeyboard() {
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      if (event.key === "Escape") {
        this.cancelPointer();
        this.clear();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        this.selectAll();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && this.hasSelection()) {
        event.preventDefault();
        this.deleteSelected();
      }
    });
  }
}

export { objectKey };
