import { combinedBounds, objectKey, parseItemKey } from "./board-geometry.js";
import { createId } from "./id.js";

const MATHJAX_SRC = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
const MAX_CAPTURE_SIDE = 1400;

export class FormulaTransformController {
  constructor({ boardId, selection, state, renderer, sendEvent, history, clientId, showToast = null }) {
    this.boardId = boardId;
    this.selection = selection;
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.history = history;
    this.clientId = clientId;
    this.showToast = showToast;
    this.busy = false;
    this.buttons = [];
    this.installButtons();
  }

  installButtons() {
    this.addButton(this.selection.contextBar?.querySelector(".image-context-normal"));
    this.addButton(document.querySelector(".selection-context-bar .image-context-normal"));
  }

  addButton(container) {
    if (!container || container.querySelector("[data-formula-transform]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.formulaTransform = "true";
    button.className = "formula-transform-action";
    button.textContent = "Преобразовать формулу";
    button.title = "Распознать выделение и заменить его аккуратной формулой";
    container.insertBefore(button, container.querySelector(".image-context-separator"));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.transform().catch((error) => {
        console.error("Formula transform failed:", error);
        this.showToast?.(humanizeFormulaError(error), "error");
      });
    });
    this.buttons.push(button);
  }

  async transform() {
    if (this.busy || !this.selection.hasSelection()) return false;
    const keys = this.selection.keys();
    const bounds = combinedBounds(this.state, keys);
    if (!bounds || bounds.width < 2 || bounds.height < 2) return false;

    this.setBusy(true);
    this.showToast?.("Распознаю формулу…", "busy");
    try {
      const imageDataUrl = await renderSelectionCapture({
        state: this.state,
        keys,
        bounds,
      });
      const result = await requestFormula(this.boardId, imageDataUrl);
      const latex = normalizeLatex(result.latex);
      if (!latex) throw new Error("Модель не вернула формулу");

      this.showToast?.("Рисую аккуратную формулу…", "busy");
      const rendered = await renderLatexPng(latex, bounds);
      const upload = await uploadFormulaAsset(this.boardId, rendered.blob);
      const placement = fitFormulaBounds(bounds, rendered.aspectRatio);
      const formulaObject = {
        id: createId(),
        kind: "image",
        ...placement,
        src: upload.src,
        name: `formula-${Date.now()}.png`,
      };

      // All slow/external work is complete before touching the board. From this
      // point replacement is one grouped local history action: Undo removes the
      // clean formula and restores every original selected item in one step.
      this.history?.beginGroup("formula-transform");
      try {
        for (const key of keys) this.deleteKey(key);
        const createEvent = { type: "object.create", op_id: createId(), object: formulaObject };
        this.state.applyEvent(createEvent, null, this.clientId);
        this.sendEvent(createEvent);
        this.history?.endGroup();
      } catch (error) {
        this.history?.endGroup();
        throw error;
      }

      this.selection.selectOnly(objectKey(formulaObject.id));
      this.renderer.invalidateBase();
      this.renderer.requestRender();
      this.showToast?.(`Формула: ${latex}`, "success");
      return true;
    } finally {
      this.setBusy(false);
    }
  }

  deleteKey(key) {
    const parsed = parseItemKey(key);
    if (!parsed) return;
    let event = null;
    if (parsed.kind === "stroke" && this.state.hasStroke(parsed.id)) {
      event = { type: "stroke.delete", op_id: createId(), stroke_id: parsed.id };
    } else if (parsed.kind === "object" && this.state.hasObject(parsed.id)) {
      event = { type: "object.delete", op_id: createId(), object_id: parsed.id };
    }
    if (!event) return;
    this.state.applyEvent(event, null, this.clientId);
    this.sendEvent(event);
  }

  setBusy(busy) {
    this.busy = Boolean(busy);
    for (const button of this.buttons) {
      button.disabled = this.busy;
      button.textContent = this.busy ? "Распознаю…" : "Преобразовать формулу";
    }
  }
}

export async function renderSelectionCapture({ state, keys, bounds }) {
  const pad = Math.max(8, Math.min(28, Math.min(bounds.width, bounds.height) * 0.08));
  const capture = {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + pad * 2,
    height: bounds.height + pad * 2,
  };
  const scale = Math.min(3, Math.max(1, MAX_CAPTURE_SIDE / Math.max(capture.width, capture.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(64, Math.ceil(capture.width * scale));
  canvas.height = Math.max(64, Math.ceil(capture.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-capture.x, -capture.y);

  const selected = new Set(keys);
  for (const object of state.listObjects()) {
    if (!selected.has(`object:${object.id}`) || object.kind !== "image") continue;
    await drawBoardImage(ctx, object);
  }
  for (const stroke of state.listStrokes()) {
    if (!selected.has(`stroke:${stroke.id}`)) continue;
    drawStroke(ctx, stroke);
  }
  ctx.restore();
  return canvas.toDataURL("image/png");
}

export function fitFormulaBounds(bounds, aspectRatio) {
  const ratio = Math.max(0.08, Math.min(40, Number(aspectRatio) || 1));
  const maxWidth = Math.max(24, Number(bounds.width));
  const maxHeight = Math.max(24, Number(bounds.height));
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  // Keep a little breathing room so the replacement does not touch the old
  // selection rectangle edges and looks natural at the original scale.
  width *= 0.94;
  height *= 0.94;
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}

async function requestFormula(boardId, imageDataUrl) {
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ai/formula`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl }),
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    const detail = payload?.detail || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return payload;
}

async function renderLatexPng(latex, bounds) {
  const mathJax = await ensureMathJax();
  const container = await mathJax.tex2svgPromise(latex, { display: true });
  const source = container.querySelector("svg");
  if (!source) throw new Error("MathJax не смог отрисовать LaTeX");
  const svg = source.cloneNode(true);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.style.margin = "0";
  svg.style.padding = "0";

  const viewBox = parseViewBox(svg.getAttribute("viewBox"));
  const aspectRatio = viewBox.width / Math.max(1, viewBox.height);
  const fitted = fitFormulaBounds(bounds, aspectRatio);
  const pixelWidth = Math.round(clamp(fitted.width * 3, 320, 2000));
  const pixelHeight = Math.max(80, Math.round(pixelWidth / aspectRatio));
  svg.setAttribute("width", String(pixelWidth));
  svg.setAttribute("height", String(pixelHeight));

  const serialized = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.drawImage(image, 0, 0, pixelWidth, pixelHeight);
    const blob = await canvasToBlob(canvas, "image/png");
    return { blob, aspectRatio };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ensureMathJax() {
  if (window.MathJax?.tex2svgPromise) return window.MathJax;
  if (!window.__localBoardMathJaxPromise) {
    window.MathJax = {
      ...(window.MathJax || {}),
      startup: { ...(window.MathJax?.startup || {}), typeset: false },
      svg: { ...(window.MathJax?.svg || {}), fontCache: "none" },
    };
    window.__localBoardMathJaxPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = MATHJAX_SRC;
      script.async = true;
      script.onload = async () => {
        try {
          await window.MathJax.startup?.promise;
          resolve(window.MathJax);
        } catch (error) { reject(error); }
      };
      script.onerror = () => reject(new Error("Не удалось загрузить MathJax"));
      document.head.appendChild(script);
    });
  }
  return window.__localBoardMathJaxPromise;
}

async function uploadFormulaAsset(boardId, blob) {
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: blob,
  });
  if (!response.ok) throw new Error(`Не удалось сохранить формулу: HTTP ${response.status}`);
  return response.json();
}

async function drawBoardImage(ctx, object) {
  const image = await loadImage(new URL(object.src, location.origin).href);
  const cropX = clamp(Number(object.crop_x ?? 0), 0, 1);
  const cropY = clamp(Number(object.crop_y ?? 0), 0, 1);
  const cropW = clamp(Number(object.crop_width ?? 1), 0.001, 1 - cropX);
  const cropH = clamp(Number(object.crop_height ?? 1), 0.001, 1 - cropY);
  ctx.drawImage(
    image,
    cropX * image.naturalWidth,
    cropY * image.naturalHeight,
    cropW * image.naturalWidth,
    cropH * image.naturalHeight,
    Number(object.x),
    Number(object.y),
    Number(object.width),
    Number(object.height),
  );
}

function drawStroke(ctx, stroke) {
  const points = stroke.points || [];
  if (!points.length) return;
  ctx.save();
  ctx.strokeStyle = stroke.color || "#111111";
  ctx.fillStyle = stroke.color || "#111111";
  ctx.lineWidth = Math.max(1, Number(stroke.width || 4));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

function parseViewBox(value) {
  const parts = String(value || "").trim().split(/[ ,]+/).map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) return { width: 1000, height: 300 };
  return { width: Math.max(1, parts[2]), height: Math.max(1, parts[3]) };
}

function normalizeLatex(value) {
  return String(value || "").trim().replace(/^\$+|\$+$/g, "").trim();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось прочитать изображение выделения"));
    image.src = src;
  });
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось создать PNG формулы")), type);
  });
}

function humanizeFormulaError(error) {
  const message = String(error?.message || error || "Не удалось преобразовать формулу");
  if (message.includes("OPENROUTER_API_KEY")) return "Не задан OPENROUTER_API_KEY на сервере";
  return message.slice(0, 220);
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
