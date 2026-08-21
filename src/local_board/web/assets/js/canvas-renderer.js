export class CanvasRenderer {
  constructor(canvas, state, boardId) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = state;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.view = this.loadView(boardId);
    this.boardId = boardId;
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
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.render();
  }

  render() {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    this.drawGrid(width, height);
    for (const stroke of this.state.listStrokes()) this.drawStroke(stroke);
  }

  drawGrid(width, height) {
    const ctx = this.ctx;
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

  drawStroke(stroke) {
    const points = stroke.points || [];
    if (!points.length) return;
    const ctx = this.ctx;
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

  panBy(dx, dy) {
    this.view.x += dx;
    this.view.y += dy;
    this.render();
  }

  zoomAt(clientX, clientY, newZoom) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const before = this.screenToWorld(clientX, clientY);
    this.view.zoom = clamp(newZoom, 0.2, 5);
    this.view.x = sx - before.x * this.view.zoom;
    this.view.y = sy - before.y * this.view.zoom;
    this.render();
  }

  resetView() {
    this.view = { x: 0, y: 0, zoom: 1 };
    this.saveView();
    this.render();
  }

  exportPng() {
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
