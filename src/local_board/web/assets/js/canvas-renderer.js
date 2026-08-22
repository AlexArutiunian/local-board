export class CanvasRenderer {
  constructor(canvas, state, boardId) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = state;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.view = this.loadView(boardId);
    this.boardId = boardId;
    this.renderHandle = null;

    // Completed strokes are expensive to redraw for every realtime append. Keep
    // them in a bitmap cache and draw only active/incomplete strokes each frame.
    // A normal in-memory canvas is used instead of OffscreenCanvas for broad
    // Safari compatibility.
    this.baseCanvas = document.createElement("canvas");
    this.baseCtx = this.baseCanvas.getContext("2d");
    this.baseDirty = true;
    this.cachedBaseGeneration = -1;

    // Remote-writer following moves only this browser's camera. New remote points
    // can retarget the animation while it is running, producing a soft tracking
    // motion instead of discrete jumps between WebSocket packets.
    this.followHandle = null;
    this.followTarget = null;
    this.followLastTimestamp = null;
    this.prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  loadView(boardId) {
    try {
      const raw = JSON.parse(localStorage.getItem(`local-board:view:${boardId}`) || "null");
      if (raw && Number.isFinite(raw.zoom)) {
        return {
          x: Number(raw.x) || 0,
          y: Number(raw.y) || 0,
          zoom: clamp(Number(raw.zoom) || 1, 0.2, 5),
        };
      }
    } catch (_) {}
    return { x: 0, y: 0, zoom: 1 };
  }

  saveView() {
    localStorage.setItem(`local-board:view:${this.boardId}`, JSON.stringify(this.view));
  }

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
  }

  getViewportSize() {
    return {
      width: this.canvas.width / this.dpr,
      height: this.canvas.height / this.dpr,
    };
  }

  invalidateBase() {
    this.baseDirty = true;
  }

  requestRender() {
    if (this.renderHandle !== null) return;
    this.renderHandle = requestAnimationFrame(() => {
      this.renderHandle = null;
      this.render();
    });
  }

  render() {
    // BoardState increments baseGeneration only when completed/static ink changes.
    // This catches local eraser/undo/clear and remote structural events without
    // forcing every caller to remember to invalidate the cache manually.
    if (this.cachedBaseGeneration !== this.state.baseGeneration) {
      this.baseDirty = true;
    }
    if (this.baseDirty) this.rebuildBase();

    // Copy the cached background/completed ink in device pixels. Then draw only
    // currently active strokes. This keeps per-frame work almost independent of
    // how much has already been written on the board.
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    for (const stroke of this.state.listStrokes()) {
      if (!stroke.complete) this.drawStrokeTo(ctx, stroke);
    }
  }

  rebuildBase() {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    const ctx = this.baseCtx;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.drawGridTo(ctx, width, height);
    for (const stroke of this.state.listStrokes()) {
      if (stroke.complete) this.drawStrokeTo(ctx, stroke);
    }
    this.baseDirty = false;
    this.cachedBaseGeneration = this.state.baseGeneration;
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

  drawStrokeTo(ctx, stroke) {
    const points = stroke.points || [];
    if (!points.length) return;

    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const pressure = averagePressure(points);
    const pressureFactor = stroke.pointer_type === "pen"
      ? clamp(0.68 + pressure * 0.75, 0.72, 1.25)
      : 1;
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

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      x: (x - this.view.x) / this.view.zoom,
      y: (y - this.view.y) / this.view.zoom,
    };
  }

  worldToScreen(point) {
    return {
      x: point.x * this.view.zoom + this.view.x,
      y: point.y * this.view.zoom + this.view.y,
    };
  }

  smoothPanBy(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    this.followTarget = {
      x: this.view.x + dx,
      y: this.view.y + dy,
    };

    if (this.prefersReducedMotion) {
      this.view.x = this.followTarget.x;
      this.view.y = this.followTarget.y;
      this.followTarget = null;
      this.invalidateBase();
      this.requestRender();
      this.saveView();
      return;
    }

    if (this.followHandle === null) {
      this.followLastTimestamp = null;
      this.followHandle = requestAnimationFrame((timestamp) => this.stepFollow(timestamp));
    }
  }

  stepFollow(timestamp) {
    this.followHandle = null;
    if (!this.followTarget) return;

    const previous = this.followLastTimestamp ?? timestamp - 16.67;
    const dt = clamp(timestamp - previous, 8, 50);
    this.followLastTimestamp = timestamp;

    const remainingX = this.followTarget.x - this.view.x;
    const remainingY = this.followTarget.y - this.view.y;
    const alpha = 1 - Math.exp(-dt / 82);

    this.view.x += remainingX * alpha;
    this.view.y += remainingY * alpha;
    this.invalidateBase();
    this.renderFollowFrame();

    const afterX = this.followTarget.x - this.view.x;
    const afterY = this.followTarget.y - this.view.y;
    if (Math.hypot(afterX, afterY) < 0.55) {
      this.view.x = this.followTarget.x;
      this.view.y = this.followTarget.y;
      this.followTarget = null;
      this.followLastTimestamp = null;
      this.invalidateBase();
      this.renderFollowFrame();
      this.saveView();
      return;
    }

    this.followHandle = requestAnimationFrame((nextTimestamp) => this.stepFollow(nextTimestamp));
  }

  renderFollowFrame() {
    // If realtime input already queued a paint for this frame, absorb it into the
    // camera paint instead of drawing twice.
    if (this.renderHandle !== null) {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
    this.render();
  }

  cancelFollowAnimation() {
    if (this.followHandle !== null) {
      cancelAnimationFrame(this.followHandle);
      this.followHandle = null;
    }
    this.followTarget = null;
    this.followLastTimestamp = null;
  }

  panBy(dx, dy) {
    this.cancelFollowAnimation();
    this.view.x += dx;
    this.view.y += dy;
    this.invalidateBase();
    this.requestRender();
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
  }

  resetView() {
    this.cancelFollowAnimation();
    this.view = { x: 0, y: 0, zoom: 1 };
    this.saveView();
    this.invalidateBase();
    this.requestRender();
  }

  exportPng() {
    // Ensure the exported bitmap includes the latest queued frame.
    this.render();
    const anchor = document.createElement("a");
    anchor.href = this.canvas.toDataURL("image/png");
    anchor.download = `local-board-${this.boardId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    anchor.click();
  }
}

function averagePressure(points) {
  return points.reduce((sum, point) => sum + Number(point.pressure ?? 0.5), 0) / points.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
