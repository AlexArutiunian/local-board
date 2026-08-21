(() => {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("stage");
  const statusEl = document.getElementById("status");
  const widthInput = document.getElementById("width");
  const widthLabel = document.getElementById("widthLabel");

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let strokes = [];
  let redoStack = [];
  let tool = "pen";
  let color = "#111111";
  let lineWidth = 4;

  let view = { x: 0, y: 0, zoom: 1 };
  let drawing = false;
  let currentStroke = null;
  let activePointer = null;
  let panStart = null;

  const touchPointers = new Map();
  let pinchStart = null;

  let saveTimer = null;
  let statusTimer = null;

  function setStatus(text, hold = 900) {
    statusEl.textContent = text;
    statusEl.style.opacity = "1";
    clearTimeout(statusTimer);
    if (hold) {
      statusTimer = setTimeout(() => {
        statusEl.style.opacity = ".55";
      }, hold);
    }
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    render();
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - view.x) / view.zoom,
      y: (sy - view.y) / view.zoom,
    };
  }

  function worldToScreen(point) {
    return {
      x: point.x * view.zoom + view.x,
      y: point.y * view.zoom + view.y,
    };
  }

  function renderGrid(width, height) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const spacing = 28 * view.zoom;
    if (spacing >= 10) {
      const startX = ((view.x % spacing) + spacing) % spacing;
      const startY = ((view.y % spacing) + spacing) % spacing;
      ctx.fillStyle = "#d1d5db";
      const radius = Math.max(0.7, Math.min(1.2, view.zoom));

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

  function renderStroke(stroke) {
    const points = stroke.points;
    if (!points || points.length === 0) return;

    ctx.save();
    ctx.strokeStyle = stroke.color || "#111111";
    ctx.fillStyle = stroke.color || "#111111";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const baseWidth = (stroke.width || 4) * view.zoom;

    if (points.length === 1) {
      const point = worldToScreen(points[0]);
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(1, baseWidth / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    const first = worldToScreen(points[0]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);

    for (let i = 1; i < points.length - 1; i++) {
      const point = worldToScreen(points[i]);
      const next = worldToScreen(points[i + 1]);
      ctx.quadraticCurveTo(
        point.x,
        point.y,
        (point.x + next.x) / 2,
        (point.y + next.y) / 2,
      );
    }

    const last = worldToScreen(points[points.length - 1]);
    ctx.lineTo(last.x, last.y);

    const averagePressure =
      points.reduce((sum, point) => sum + (point.pressure || 0.5), 0) / points.length;
    const pressureFactor = stroke.pointerType === "pen"
      ? Math.max(0.72, Math.min(1.25, 0.68 + averagePressure * 0.75))
      : 1;

    ctx.lineWidth = Math.max(1, baseWidth * pressureFactor);
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    renderGrid(width, height);

    for (const stroke of strokes) renderStroke(stroke);
    if (currentStroke) renderStroke(currentStroke);
  }

  function distancePointToSegment(point, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = point.x - a.x;
    const wy = point.y - a.y;
    const c1 = vx * wx + vy * wy;

    if (c1 <= 0) return Math.hypot(point.x - a.x, point.y - a.y);

    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(point.x - b.x, point.y - b.y);

    const t = c1 / c2;
    const px = a.x + t * vx;
    const py = a.y + t * vy;
    return Math.hypot(point.x - px, point.y - py);
  }

  function eraseAt(worldPoint) {
    const radius = 18 / view.zoom;
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let i = strokes.length - 1; i >= 0; i--) {
      const points = strokes[i].points || [];

      if (points.length === 1) {
        const distance = Math.hypot(
          worldPoint.x - points[0].x,
          worldPoint.y - points[0].y,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
        continue;
      }

      for (let j = 0; j < points.length - 1; j++) {
        const distance = distancePointToSegment(worldPoint, points[j], points[j + 1]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
    }

    if (bestIndex >= 0 && bestDistance <= radius) {
      strokes.splice(bestIndex, 1);
      redoStack = [];
      scheduleSave();
      render();
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBoard, 220);
  }

  async function saveBoard() {
    try {
      setStatus("Сохраняю…", 0);
      const response = await fetch("/api/board", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, strokes, view }),
      });

      if (!response.ok) throw new Error("save failed");
      setStatus("Сохранено");
    } catch (error) {
      console.error(error);
      setStatus("Ошибка сохранения", 1800);
    }
  }

  async function loadBoard() {
    try {
      const response = await fetch("/api/board", { cache: "no-store" });
      const data = await response.json();
      strokes = Array.isArray(data.strokes) ? data.strokes : [];

      if (data.view && Number.isFinite(data.view.zoom)) {
        view = {
          x: Number(data.view.x) || 0,
          y: Number(data.view.y) || 0,
          zoom: Math.min(5, Math.max(0.2, Number(data.view.zoom) || 1)),
        };
      }

      render();
      setStatus(strokes.length ? `Загружено: ${strokes.length} штрихов` : "Новая доска");
    } catch (error) {
      console.error(error);
      setStatus("Не удалось загрузить", 1800);
    }
  }

  function addPoint(event) {
    if (!currentStroke) return;

    const point = screenToWorld(event.clientX, event.clientY);
    const previous = currentStroke.points[currentStroke.points.length - 1];

    if (
      previous &&
      Math.hypot(point.x - previous.x, point.y - previous.y) < 0.55 / view.zoom
    ) {
      return;
    }

    currentStroke.points.push({
      x: point.x,
      y: point.y,
      pressure: event.pressure || (event.pointerType === "pen" ? 0.45 : 0.5),
    });
  }

  function startDraw(event) {
    drawing = true;
    activePointer = event.pointerId;
    currentStroke = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      color,
      width: lineWidth,
      pointerType: event.pointerType || "mouse",
      points: [],
    };

    addPoint(event);
    canvas.setPointerCapture?.(event.pointerId);
    redoStack = [];
    render();
  }

  function finishDraw(event) {
    if (!drawing || activePointer !== event.pointerId) return;

    addPoint(event);
    if (currentStroke && currentStroke.points.length) {
      strokes.push(currentStroke);
    }

    currentStroke = null;
    drawing = false;
    activePointer = null;
    scheduleSave();
    render();
  }

  function startPan(event) {
    activePointer = event.pointerId;
    panStart = {
      clientX: event.clientX,
      clientY: event.clientY,
      viewX: view.x,
      viewY: view.y,
    };
    canvas.setPointerCapture?.(event.pointerId);
  }

  function movePan(event) {
    if (!panStart || activePointer !== event.pointerId) return;

    view.x = panStart.viewX + (event.clientX - panStart.clientX);
    view.y = panStart.viewY + (event.clientY - panStart.clientY);
    render();
  }

  function endPan(event) {
    if (activePointer !== event.pointerId) return;

    activePointer = null;
    panStart = null;
    scheduleSave();
  }

  function updatePinch() {
    if (touchPointers.size !== 2) {
      pinchStart = null;
      return;
    }

    const [a, b] = [...touchPointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centerX = (a.x + b.x) / 2;
    const centerY = (a.y + b.y) / 2;

    if (!pinchStart) {
      const world = screenToWorld(centerX, centerY);
      pinchStart = {
        distance,
        zoom: view.zoom,
        worldX: world.x,
        worldY: world.y,
      };
      return;
    }

    const newZoom = Math.max(
      0.2,
      Math.min(5, pinchStart.zoom * distance / pinchStart.distance),
    );

    const rect = canvas.getBoundingClientRect();
    const screenX = centerX - rect.left;
    const screenY = centerY - rect.top;

    view.zoom = newZoom;
    view.x = screenX - pinchStart.worldX * newZoom;
    view.y = screenY - pinchStart.worldY * newZoom;
    render();
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();

    if (event.pointerType === "touch") {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointers.size >= 2) {
        if (drawing) {
          currentStroke = null;
          drawing = false;
          activePointer = null;
        }
        updatePinch();
        return;
      }
    }

    if (tool === "pan") {
      startPan(event);
    } else if (tool === "eraser") {
      activePointer = event.pointerId;
      eraseAt(screenToWorld(event.clientX, event.clientY));
      canvas.setPointerCapture?.(event.pointerId);
    } else {
      startDraw(event);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    event.preventDefault();

    if (event.pointerType === "touch" && touchPointers.has(event.pointerId)) {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointers.size >= 2) {
        updatePinch();
        return;
      }
    }

    if (tool === "pan") {
      movePan(event);
    } else if (tool === "eraser" && activePointer === event.pointerId) {
      eraseAt(screenToWorld(event.clientX, event.clientY));
    } else if (drawing && activePointer === event.pointerId) {
      const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
      for (const coalescedEvent of events) addPoint(coalescedEvent);
      render();
    }
  });

  function endPointer(event) {
    if (event.pointerType === "touch") {
      touchPointers.delete(event.pointerId);
      if (touchPointers.size < 2) pinchStart = null;
    }

    if (tool === "pan") {
      endPan(event);
    } else if (tool === "eraser") {
      if (activePointer === event.pointerId) {
        activePointer = null;
        scheduleSave();
      }
    } else {
      finishDraw(event);
    }
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const before = screenToWorld(event.clientX, event.clientY);
    const factor = Math.exp(-event.deltaY * 0.0015);

    view.zoom = Math.max(0.2, Math.min(5, view.zoom * factor));
    view.x = screenX - before.x * view.zoom;
    view.y = screenY - before.y * view.zoom;
    render();
    scheduleSave();
  }, { passive: false });

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      tool = button.dataset.tool;
      document.querySelectorAll("[data-tool]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
      canvas.style.cursor = tool === "pan"
        ? "grab"
        : tool === "eraser"
          ? "cell"
          : "crosshair";
    });
  });

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      color = button.dataset.color;
      document.querySelectorAll("[data-color]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
      if (tool !== "pen") document.querySelector('[data-tool="pen"]').click();
    });
  });

  widthInput.addEventListener("input", () => {
    lineWidth = Number(widthInput.value);
    widthLabel.textContent = String(lineWidth);
  });

  document.getElementById("undo").addEventListener("click", () => {
    if (!strokes.length) return;
    redoStack.push(strokes.pop());
    scheduleSave();
    render();
  });

  document.getElementById("redo").addEventListener("click", () => {
    if (!redoStack.length) return;
    strokes.push(redoStack.pop());
    scheduleSave();
    render();
  });

  document.getElementById("fit").addEventListener("click", () => {
    view = { x: 0, y: 0, zoom: 1 };
    scheduleSave();
    render();
  });

  document.getElementById("clear").addEventListener("click", async () => {
    const ok = confirm("Очистить всю доску? Это действие нельзя отменить после перезагрузки.");
    if (!ok) return;

    strokes = [];
    redoStack = [];
    render();

    try {
      await fetch("/api/clear", { method: "POST" });
      setStatus("Доска очищена");
    } catch {
      scheduleSave();
    }
  });

  document.getElementById("export").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `whiteboard-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    link.click();
  });

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveBoard();
  });

  resize();
  loadBoard();
})();
