import {
  allItemKeys,
  combinedBounds,
  hitTest,
  itemsIntersectingRect,
  objectKey,
  parseItemKey,
} from "./board-geometry.js";
import { cloneBoardObject } from "./board-state.js";
import { createId } from "./id.js";

const MOUSE_DRAG_THRESHOLD = 6;
const TOUCH_DRAG_THRESHOLD = 10;
const CLIPBOARD_MARKER = "local-board:image-object";

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
    this.screenAnchor = null;
    this.originals = new Map();
    this.lastDelta = { dx: 0, dy: 0 };
    this.marqueeAdditive = false;
    this.pendingForceMarquee = false;

    this.cropObjectId = null;
    this.cropRect = null;
    this.cropOriginalRect = null;

    this.imageClipboard = null;
    this.contextBar = this.createImageContextBar();
    this.contextFrame = null;

    this.bindRightMouseShortcut();
    this.bindImageDoubleClick();
    this.bindKeyboard();
    this.bindClipboard();
  }

  ownsPointer(pointerId) { return this.activePointerId === pointerId; }
  hasSelection() { return this.selected.size > 0; }
  keys() { return [...this.selected]; }
  isCropping() { return this.cropObjectId !== null && this.cropRect !== null; }

  setSelection(keys) {
    const next = new Set(Array.from(keys || []).filter((key) => this.itemExists(key)));
    if (this.isCropping() && !next.has(objectKey(this.cropObjectId))) this.clearCropState();
    this.selected = next;
    this.renderer.setSelection(this.selected);
    this.notifySelection();
  }

  selectOnly(key) { this.setSelection(key ? [key] : []); }
  clear() { this.setSelection([]); }
  selectAll() { this.setSelection(allItemKeys(this.state)); }

  selectedImage() {
    if (this.selected.size !== 1) return null;
    const parsed = parseItemKey([...this.selected][0]);
    if (parsed?.kind !== "object") return null;
    const object = this.state.getObject(parsed.id);
    return object?.kind === "image" ? object : null;
  }

  startCrop() {
    const object = this.selectedImage();
    if (!object) return false;
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

  resetSelectedCrop() {
    const object = this.selectedImage();
    if (!object || !hasAppliedCrop(object)) return false;
    const cropWidth = Math.max(0.01, Number(object.crop_width ?? 1));
    const cropHeight = Math.max(0.01, Number(object.crop_height ?? 1));
    const fullWidth = object.width / cropWidth;
    const fullHeight = object.height / cropHeight;
    const patch = {
      x: object.x - Number(object.crop_x ?? 0) * fullWidth,
      y: object.y - Number(object.crop_y ?? 0) * fullHeight,
      width: fullWidth,
      height: fullHeight,
      crop_x: 0,
      crop_y: 0,
      crop_width: 1,
      crop_height: 1,
    };
    const event = { type: "object.update", op_id: createId(), object_id: object.id, patch };
    this.state.applyEvent(event, null, this.clientId);
    this.sendEvent(event);
    this.renderer.invalidateBase();
    this.renderer.requestRender();
    this.notifySelection();
    return true;
  }

  copySelectedImage({ writeSystemClipboard = true } = {}) {
    const object = this.selectedImage();
    if (!object) return false;
    this.imageClipboard = cloneBoardObject(object);
    if (writeSystemClipboard) this.writeClipboardMarker();
    this.flashContextAction("imageCopy", "Скопировано");
    return true;
  }

  duplicateSelectedImage() {
    const object = this.selectedImage();
    if (!object) return false;
    return this.createImageCopy(object);
  }

  pasteCopiedImage() {
    if (!this.imageClipboard) return false;
    return this.createImageCopy(this.imageClipboard);
  }

  createImageCopy(source) {
    const offset = 24 / Math.max(0.2, this.renderer.view.zoom);
    const object = {
      id: createId(),
      kind: "image",
      x: Number(source.x) + offset,
      y: Number(source.y) + offset,
      width: Number(source.width),
      height: Number(source.height),
      src: String(source.src),
      name: String(source.name || "image"),
      crop_x: Number(source.crop_x ?? 0),
      crop_y: Number(source.crop_y ?? 0),
      crop_width: Number(source.crop_width ?? 1),
      crop_height: Number(source.crop_height ?? 1),
    };
    const event = { type: "object.create", op_id: createId(), object };
    this.state.applyEvent(event, null, this.clientId);
    this.sendEvent(event);
    this.selectOnly(objectKey(object.id));
    this.renderer.invalidateBase();
    this.renderer.requestRender();
    return true;
  }

  reorderSelectedImage(position) {
    const object = this.selectedImage();
    if (!object || !["front", "back"].includes(position)) return false;
    const event = { type: "object.reorder", op_id: createId(), object_id: object.id, position };
    this.state.applyEvent(event, null, this.clientId);
    this.sendEvent(event);
    this.renderer.invalidateBase();
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
      this.mode = "pending-marquee";
      this.marqueeAdditive = additive;
      this.pendingForceMarquee = true;
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
        this.mode = "pending-move";
        this.captureOriginals();
      } else {
        this.finishGestureState();
      }
      return true;
    }

    this.mode = "pending-marquee";
    this.marqueeAdditive = additive;
    this.pendingForceMarquee = false;
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
    this.screenAnchor = { x: event.clientX, y: event.clientY };
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
    const dx = world.x - this.anchor.x;
    const dy = world.y - this.anchor.y;
    this.lastDelta = { dx, dy };

    if (this.mode === "pending-marquee" || this.mode === "pending-move") {
      if (!this.dragThresholdReached(event)) return true;
      if (this.mode === "pending-marquee") {
        if (!this.marqueeAdditive) this.clear();
        this.mode = "marquee";
        this.renderer.setMarquee({ x1: this.anchor.x, y1: this.anchor.y, x2: world.x, y2: world.y });
        return true;
      }
      this.mode = "move";
    }

    if (this.mode === "marquee") {
      this.renderer.setMarquee({ x1: this.anchor.x, y1: this.anchor.y, x2: world.x, y2: world.y });
      return true;
    }

    if (this.mode === "move") this.previewMove(dx, dy);
    else if (this.mode === "resize") this.previewResize(dx, dy);
    else if (this.mode.startsWith("crop:")) this.previewCrop(this.mode.slice(5), dx, dy);
    return true;
  }

  pointerUp(event) {
    if (!this.ownsPointer(event.pointerId)) return false;
    const mode = this.mode;

    if (mode === "pending-marquee") {
      // A plain empty click clears selection, but an accidental RMB click does
      // nothing. Marquee only exists after crossing the drag threshold.
      if (!this.pendingForceMarquee && !this.marqueeAdditive) this.clear();
    } else if (mode === "marquee") {
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

  dragThresholdReached(event) {
    if (!this.screenAnchor) return true;
    const threshold = this.activePointerType === "touch" ? TOUCH_DRAG_THRESHOLD : MOUSE_DRAG_THRESHOLD;
    return Math.hypot(event.clientX - this.screenAnchor.x, event.clientY - this.screenAnchor.y) >= threshold;
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

  finishGestureState() {
    this.activePointerId = null;
    this.activePointerType = null;
    this.requiredButtonMask = 0;
    this.mode = null;
    this.anchor = null;
    this.screenAnchor = null;
    this.originals.clear();
    this.lastDelta = { dx: 0, dy: 0 };
    this.marqueeAdditive = false;
    this.pendingForceMarquee = false;
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
    }, { capture: true, passive: false });
  }

  bindImageDoubleClick() {
    this.canvas.addEventListener("dblclick", (event) => {
      if (this.isCropping()) return;
      const world = this.renderer.screenToWorld(event.clientX, event.clientY);
      const hit = hitTest(this.state, world, 7 / this.renderer.view.zoom);
      const parsed = parseItemKey(hit);
      if (parsed?.kind !== "object") return;
      const object = this.state.getObject(parsed.id);
      if (object?.kind !== "image") return;
      event.preventDefault();
      this.selectOnly(hit);
      this.startCrop();
    }, { passive: false });
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

  notifySelection() {
    this.syncImageContextBar();
    this.onSelectionChange?.(this.keys());
  }

  createImageContextBar() {
    if (typeof document === "undefined") return null;
    const bar = document.createElement("div");
    bar.className = "image-context-bar hidden";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Действия с изображением");
    bar.innerHTML = `
      <div class="image-context-normal">
        <button type="button" data-image-action="crop" title="Обрезать изображение">Обрезать</button>
        <button id="imageCopy" type="button" data-image-action="copy" title="Копировать изображение">Копировать</button>
        <button type="button" data-image-action="duplicate" title="Создать копию">Дубликат</button>
        <span class="image-context-separator"></span>
        <button class="image-context-icon" type="button" data-image-action="back" title="На задний план" aria-label="На задний план">↓</button>
        <button class="image-context-icon" type="button" data-image-action="front" title="На передний план" aria-label="На передний план">↑</button>
        <button type="button" data-image-action="reset-crop" title="Вернуть изображение целиком">Сбросить crop</button>
        <button class="danger image-context-icon" type="button" data-image-action="delete" title="Удалить изображение" aria-label="Удалить изображение">×</button>
      </div>
      <div class="image-context-crop hidden">
        <span class="image-context-label">Кадрирование</span>
        <button class="primary-action" type="button" data-image-action="apply-crop">Готово</button>
        <button type="button" data-image-action="cancel-crop">Отмена</button>
      </div>
    `;
    this.canvas.parentElement?.appendChild(bar);
    bar.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.renderer.cancelFollowAnimation?.();
    });
    bar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-image-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.imageAction;
      if (action === "crop") this.startCrop();
      else if (action === "copy") this.copySelectedImage();
      else if (action === "duplicate") this.duplicateSelectedImage();
      else if (action === "front") this.reorderSelectedImage("front");
      else if (action === "back") this.reorderSelectedImage("back");
      else if (action === "reset-crop") this.resetSelectedCrop();
      else if (action === "delete") this.deleteSelected();
      else if (action === "apply-crop") this.applyCrop();
      else if (action === "cancel-crop") this.cancelCrop();
    });
    return bar;
  }

  syncImageContextBar() {
    const bar = this.contextBar;
    if (!bar) return;
    const image = this.selectedImage();
    if (!image) {
      bar.classList.add("hidden");
      this.stopContextPositionLoop();
      return;
    }
    bar.classList.remove("hidden");
    bar.querySelector(".image-context-normal")?.classList.toggle("hidden", this.isCropping());
    bar.querySelector(".image-context-crop")?.classList.toggle("hidden", !this.isCropping());
    const reset = bar.querySelector('[data-image-action="reset-crop"]');
    reset?.classList.toggle("hidden", !hasAppliedCrop(image));
    this.positionImageContextBar();
    this.startContextPositionLoop();
  }

  positionImageContextBar() {
    const bar = this.contextBar;
    const image = this.selectedImage();
    if (!bar || !image || bar.classList.contains("hidden")) return;
    const stage = this.canvas.parentElement;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const topLeft = this.renderer.worldToScreen(image);
    const imageWidth = image.width * this.renderer.view.zoom;
    const imageHeight = image.height * this.renderer.view.zoom;
    const barWidth = bar.offsetWidth || 460;
    const barHeight = bar.offsetHeight || 44;
    const center = clamp(topLeft.x + imageWidth / 2, barWidth / 2 + 10, stageRect.width - barWidth / 2 - 10);
    let top = topLeft.y - barHeight - 10;
    if (top < 68) top = topLeft.y + imageHeight + 10;
    top = clamp(top, 8, Math.max(8, stageRect.height - barHeight - 8));
    bar.style.left = `${center}px`;
    bar.style.top = `${top}px`;
  }

  startContextPositionLoop() {
    if (this.contextFrame !== null || typeof requestAnimationFrame !== "function") return;
    const step = () => {
      this.contextFrame = null;
      if (!this.contextBar || this.contextBar.classList.contains("hidden")) return;
      this.positionImageContextBar();
      this.contextFrame = requestAnimationFrame(step);
    };
    this.contextFrame = requestAnimationFrame(step);
  }

  stopContextPositionLoop() {
    if (this.contextFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.contextFrame);
    this.contextFrame = null;
  }

  flashContextAction(id, label) {
    const button = this.contextBar?.querySelector(`#${id}`);
    if (!button) return;
    const previous = button.textContent;
    button.textContent = label;
    setTimeout(() => { if (button.isConnected) button.textContent = previous; }, 900);
  }

  bindClipboard() {
    if (typeof document === "undefined") return;
    document.addEventListener("copy", (event) => {
      if (isEditableTarget(event.target) || !this.selectedImage()) return;
      this.copySelectedImage({ writeSystemClipboard: false });
      try {
        event.clipboardData?.setData("text/plain", CLIPBOARD_MARKER);
        event.preventDefault();
      } catch (_) {}
    });
    document.addEventListener("paste", (event) => {
      if (isEditableTarget(event.target) || !this.imageClipboard) return;
      const imageFiles = [...(event.clipboardData?.files || [])].filter((file) => file.type?.startsWith("image/"));
      if (imageFiles.length) return;
      const marker = event.clipboardData?.getData("text/plain") || "";
      if (marker !== CLIPBOARD_MARKER && !this.imageClipboard) return;
      event.preventDefault();
      this.pasteCopiedImage();
    });
  }

  writeClipboardMarker() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(CLIPBOARD_MARKER).catch(() => this.execCopyFallback());
      return;
    }
    this.execCopyFallback();
  }

  execCopyFallback() {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = CLIPBOARD_MARKER;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    } catch (_) {}
  }

  bindKeyboard() {
    document.addEventListener("keydown", (event) => {
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.key === "Escape") {
        if (this.isCropping()) this.cancelCrop();
        else {
          this.cancelPointer();
          this.clear();
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "a") {
        event.preventDefault();
        this.selectAll();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "d" && this.selectedImage()) {
        event.preventDefault();
        this.duplicateSelectedImage();
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
    crop_x: stableCropValue(baseX + localX * baseW),
    crop_y: stableCropValue(baseY + localY * baseH),
    crop_width: stableCropValue(localW * baseW),
    crop_height: stableCropValue(localH * baseH),
  };
}

function stableCropValue(value) {
  return Math.round(value * 1e12) / 1e12;
}

function hasAppliedCrop(object) {
  return Math.abs(Number(object?.crop_x ?? 0)) > 1e-6
    || Math.abs(Number(object?.crop_y ?? 0)) > 1e-6
    || Math.abs(Number(object?.crop_width ?? 1) - 1) > 1e-6
    || Math.abs(Number(object?.crop_height ?? 1) - 1) > 1e-6;
}

function buttonMask(button) {
  if (button === 0) return 1;
  if (button === 1) return 4;
  if (button === 2) return 2;
  if (button === 3) return 8;
  if (button === 4) return 16;
  return 0;
}

function isEditableTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export { objectKey };
