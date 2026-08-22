import { combinedBounds, normalizeRect, parseItemKey } from "./board-geometry.js";
import { ImageCache } from "./image-cache.js";

export class CanvasRenderer {
  constructor(canvas, state, boardId) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = state;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.view = this.loadView(boardId);
    this.boardId = boardId;
    this.renderHandle = null;
    this.onViewChange = null;
    this.selectionKeys = new Set();
    this.marquee = null;

    this.imageCache = new ImageCache(() => {
      this.invalidateBase();
      this.requestRender();
    });

    this.baseCanvas = document.createElement("canvas");
    this.baseCtx = this.baseCanvas.getContext("2d");
    this.baseDirty = true;
    this.cachedBaseGeneration = -1;
    this.cachedBaseView = null;

    this.followHandle = null;
    this.followTarget = null;
    this.followLastTimestamp = null;
    this.followTimeConstant = 340;
    this.prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  setViewChangeListener(listener) {
    this.onViewChange = typeof listener === "function" ? listener : null;
    this.emitViewChange();
  }

  emitViewChange() { this.onViewChange?.({ ...this.view }); }

  setSelection(keys) {
    this.selectionKeys = new Set(keys || []);
    this.requestRender();
  }

  setMarquee(rect) {
    this.marquee = rect ? normalizeRect(rect) : null;
    this.requestRender();
  }

  loadView(boardId) {
    try {
      const raw = JSON.parse(localStorage.getItem(`local-board:view:${boardId}`) || "null");
      if (raw && Number.isFinite(raw.zoom)) {
        return { x: Number(raw.x) || 0, y: Number(raw.y) || 0, zoom: clamp(Number(raw.zoom) || 1, 0.2, 5) };
      }
    } catch (_) {}
    return { x: 0, y: 0, zoom: 1 };
  }

  saveView() { localStorage.setItem(`local-board:view:${this.boardId}`, JSON.stringify(this.view)); }

  resize() {
    this.cancelFollowAnimation();
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(rect.width * this.dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * this.dpr));
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.baseCanvas.width = pixelWidth;
    this.baseCanvas.height = pixelHeight;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.invalidateBase();
    this.render();
    this.emitViewChange();
  }

  getViewportSize() { return { width: this.canvas.width / this.dpr, height: this.canvas.height / this.dpr }; }
  invalidateBase() { this.baseDirty = true; }

  requestRender() {
    if (this.renderHandle !== null) return;
    this.renderHandle = requestAnimationFrame(() => {
      this.renderHandle = null;
      this.render();
    });
  }

  render({ showSelection = true } = {}) {
    if (this.cachedBaseGeneration !== this.state.baseGeneration) this.baseDirty = true;
    if (!this.baseDirty && this.shouldRefreshTransformedBase()) this.baseDirty = true;
    if (this.baseDirty) this.rebuildBase();

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawCachedBase(ctx);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const stroke of this.state.listStrokes()) {
      if (!stroke.complete) this.drawStrokeTo(ctx, stroke);
    }
    if (showSelection) this.drawSelectionOverlay(ctx);
  }

  drawCachedBase(ctx) {
    if (!this.cachedBaseView) {
      ctx.drawImage(this.baseCanvas, 0, 0);
      return;
    }
    const ratio = this.view.zoom / this.cachedBaseView.zoom;
    const translateX = (this.view.x - this.cachedBaseView.x * ratio) * this.dpr;
    const translateY = (this.view.y - this.cachedBaseView.y * ratio) * this.dpr;
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, translateX, translateY);
    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.restore();
  }

  shouldRefreshTransformedBase() {
    if (!this.cachedBaseView || !this.followTarget) return false;
    const ratio = this.view.zoom / this.cachedBaseView.zoom;
    const { width, height } = this.getViewportSize();
    const shiftX = this.view.x - this.cachedBaseView.x * ratio;
    const shiftY = this.view.y - this.cachedBaseView.y * ratio;
    return ratio < 0.72 || ratio > 1.38 || Math.abs(shiftX) > width * 0.20 || Math.abs(shiftY) > height * 0.20;
  }

  rebuildBase() {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    const ctx = this.baseCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawGridTo(ctx, width, height);
    for (const object of this.state.listObjects()) this.drawObjectTo(ctx, object);
    for (const stroke of this.state.listStrokes()) {
      if (stroke.complete) this.drawStrokeTo(ctx, stroke);
    }
    this.baseDirty = false;
    this.cachedBaseGeneration = this.state.baseGeneration;
    this.cachedBaseView = { ...this.view };
  }

  drawGridTo(ctx, width, height) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const spacing = 28 * this.view.zoom;
    if (spacing >= 10) {
      const startX = ((this.view.x % spacing) + spacing) % spacing;
      const startY = ((this.view.y % spacing) + spacing) % spacing;
      ctx.fillStyle = "#d6d3d1";
      const radius = clamp(this.view.zoom, 0.7, 1.15);
      for (let x = startX; x < width; x += spacing) {
        for (let y = startY; y < height; y += spacing) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  drawObjectTo(ctx, object) {
    if (object.kind !== "image") return;
    const topLeft = this.worldToScreen(object);
    const width = object.width * this.view.zoom;
    const height = object.height * this.view.zoom;
    const image = this.imageCache.get(object.src);
    ctx.save();
    if (image) {
      ctx.drawImage(image, topLeft.x, topLeft.y, width, height);
    } else {
      ctx.fillStyle = "#f5f5f4";
      ctx.strokeStyle = "#d6d3d1";
      ctx.lineWidth = 1;
      ctx.fillRect(topLeft.x, topLeft.y, width, height);
      ctx.strokeRect(topLeft.x, topLeft.y, width, height);
    }
    ctx.restore();
  }

  drawStrokeTo(ctx, stroke) {
    const points = stroke.points || [];
    if (!points.length) return;
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pressure = averagePressure(points);
    const pressureFactor = stroke.pointer_type === "pen" ? clamp(0.68 + pressure * 0.75, 0.72, 1.25) : 1;
    const width = Math.max(1, stroke.width * this.view.zoom * pressureFactor);
    if (points.length === 1) {
      const p = this.worldToScreen(points[0]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    const first = this.worldToScreen(points[0]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length - 1; i += 1) {
      const p = this.worldToScreen(points[i]);
      const next = this.worldToScreen(points[i + 1]);
      ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
    }
    const last = this.worldToScreen(points[points.length - 1]);
    ctx.lineTo(last.x, last.y);
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  drawSelectionOverlay(ctx) {
    ctx.save();
    if (this.marquee) {
      const start = this.worldToScreen({ x: this.marquee.x, y: this.marquee.y });
      const width = this.marquee.width * this.view.zoom;
      const height = this.marquee.height * this.view.zoom;
      ctx.fillStyle = "rgba(37,99,235,.08)";
      ctx.strokeStyle = "rgba(37,99,235,.75)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.fillRect(start.x, start.y, width, height);
      ctx.strokeRect(start.x, start.y, width, height);
    }

    const bounds = combinedBounds(this.state, this.selectionKeys);
    if (bounds) {
      const start = this.worldToScreen(bounds);
      const width = bounds.width * this.view.zoom;
      const height = bounds.height * this.view.zoom;
      ctx.strokeStyle = "#2563eb";
      ctx.fillStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.strokeRect(start.x, start.y, width, height);
      const single = this.selectionKeys.size === 1 ? parseItemKey([...this.selectionKeys][0]) : null;
      if (single?.kind === "object") {
        for (const [x, y] of [[start.x, start.y], [start.x + width, start.y], [start.x, start.y + height], [start.x + width, start.y + height]]) {
          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x: (x - this.view.x) / this.view.zoom, y: (y - this.view.y) / this.view.zoom };
  }

  worldToScreen(point) { return { x: point.x * this.view.zoom + this.view.x, y: point.y * this.view.zoom + this.view.y }; }

  smoothPanBy(dx, dy, { timeConstant = 340 } = {}) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false;
    return this.smoothViewTo({ x: this.view.x + dx, y: this.view.y + dy, zoom: this.view.zoom }, { timeConstant });
  }

  smoothFocusWorldPoint(point, { zoom = this.view.zoom, screenX = null, screenY = null, timeConstant = 340 } = {}) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    const { width, height } = this.getViewportSize();
    const targetZoom = clamp(Number(zoom) || this.view.zoom, 0.2, 5);
    const desiredX = Number.isFinite(screenX) ? screenX : width * 0.5;
    const desiredY = Number.isFinite(screenY) ? screenY : height * 0.48;
    return this.smoothViewTo({ x: desiredX - point.x * targetZoom, y: desiredY - point.y * targetZoom, zoom: targetZoom }, { timeConstant });
  }

  smoothViewTo(target, { timeConstant = 340 } = {}) {
    if (!target) return false;
    const next = { x: Number(target.x), y: Number(target.y), zoom: clamp(Number(target.zoom) || this.view.zoom, 0.2, 5) };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return false;
    const positionDistance = Math.hypot(next.x - this.view.x, next.y - this.view.y);
    const zoomDistance = Math.abs(Math.log(next.zoom / this.view.zoom));
    if (positionDistance < 0.5 && zoomDistance < 0.002) return false;
    this.followTarget = next;
    this.followTimeConstant = clamp(Number(timeConstant) || 340, 80, 1200);
    if (this.prefersReducedMotion) {
      this.view = { ...next };
      this.followTarget = null;
      this.invalidateBase();
      this.requestRender();
      this.saveView();
      this.emitViewChange();
      return true;
    }
    if (this.followHandle === null) {
      this.followLastTimestamp = null;
      this.followHandle = requestAnimationFrame((timestamp) => this.stepFollow(timestamp));
    }
    return true;
  }

  stepFollow(timestamp) {
    this.followHandle = null;
    if (!this.followTarget) return;
    const previous = this.followLastTimestamp ?? timestamp - 16.67;
    const dt = clamp(timestamp - previous, 8, 50);
    this.followLastTimestamp = timestamp;
    const alpha = 1 - Math.exp(-dt / this.followTimeConstant);
    this.view.x += (this.followTarget.x - this.view.x) * alpha;
    this.view.y += (this.followTarget.y - this.view.y) * alpha;
    this.view.zoom += (this.followTarget.zoom - this.view.zoom) * alpha;
    this.emitViewChange();
    this.renderFollowFrame();
    const afterX = this.followTarget.x - this.view.x;
    const afterY = this.followTarget.y - this.view.y;
    const afterZoom = Math.abs(Math.log(this.followTarget.zoom / this.view.zoom));
    if (Math.hypot(afterX, afterY) < 0.55 && afterZoom < 0.0015) {
      this.view = { ...this.followTarget };
      this.followTarget = null;
      this.followLastTimestamp = null;
      this.invalidateBase();
      this.renderFollowFrame();
      this.saveView();
      this.emitViewChange();
      return;
    }
    this.followHandle = requestAnimationFrame((nextTimestamp) => this.stepFollow(nextTimestamp));
  }

  renderFollowFrame() {
    if (this.renderHandle !== null) {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
    this.render();
  }

  cancelFollowAnimation() {
    const wasAnimating = this.followHandle !== null || this.followTarget !== null;
    if (this.followHandle !== null) cancelAnimationFrame(this.followHandle);
    this.followHandle = null;
    this.followTarget = null;
    this.followLastTimestamp = null;
    if (wasAnimating) this.invalidateBase();
  }

  panBy(dx, dy) {
    this.cancelFollowAnimation();
    this.view.x += dx;
    this.view.y += dy;
    this.invalidateBase();
    this.requestRender();
    this.emitViewChange();
  }

  zoomAt(clientX, clientY, newZoom) {
    this.cancelFollowAnimation();
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const before = this.screenToWorld(clientX, clientY);
    this.view.zoom = clamp(newZoom, 0.2, 5);
    this.view.x = sx - before.x * this.view.zoom;
    this.view.y = sy - before.y * this.view.zoom;
    this.invalidateBase();
    this.requestRender();
    this.emitViewChange();
  }

  resetZoom() {
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
    this.saveView();
  }

  resetView() {
    this.cancelFollowAnimation();
    this.view = { x: 0, y: 0, zoom: 1 };
    this.saveView();
    this.invalidateBase();
    this.requestRender();
    this.emitViewChange();
  }

  exportPng() {
    this.invalidateBase();
    this.render({ showSelection: false });
    const anchor = document.createElement("a");
    anchor.href = this.canvas.toDataURL("image/png");
    anchor.download = `local-board-${this.boardId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    anchor.click();
    this.requestRender();
  }
}

function averagePressure(points) {
  return points.reduce((sum, point) => sum + Number(point.pressure ?? 0.5), 0) / points.length;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
