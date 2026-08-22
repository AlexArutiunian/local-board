import { BoardState, cloneStroke } from "./board-state.js";
import { CanvasRenderer } from "./canvas-renderer.js";
import { InputController } from "./input-controller.js";
import { createInputDiagnostics } from "./input-diagnostics.js";
import { RealtimeClient } from "./realtime-client.js";
import { RemoteFollowController } from "./remote-follow.js";
import { createId } from "./id.js";

const boardId = resolveBoardId();
const clientId = getClientId();
const state = new BoardState();
const canvas = document.getElementById("board");
const renderer = new CanvasRenderer(canvas, state, boardId);
const remoteFollow = new RemoteFollowController({ renderer, localClientId: clientId });
const localUndo = [];
const localRedo = [];
const inputDebug = createInputDiagnostics();

document.getElementById("boardName").textContent = boardId;
bindInputDiagnostics(canvas, inputDebug);
renderer.setViewChangeListener(updateZoomButton);

let realtime;
const input = new InputController({
  canvas,
  state,
  renderer,
  clientId,
  sendEvent: sendLocalEvent,
  onStrokeFinished: (strokeId) => {
    localUndo.push(strokeId);
    localRedo.length = 0;
    updateUndoButtons();
  },
});

bindRemoteFollowInteractionGuards(canvas, remoteFollow);

realtime = new RealtimeClient({
  boardId,
  clientId,
  onSnapshot: (board, pendingEvents) => {
    state.applySnapshot(board);
    for (const pending of pendingEvents) state.applyEvent(pending, null, clientId);
    remoteFollow.seedLastFromStrokes(state.listStrokes());
    renderer.render();
    updateGoToLastButton();
  },
  onEvent: (event, revision, actorId) => {
    state.applyEvent(event, revision, actorId);
    remoteFollow.observe(event, actorId);
    renderer.requestRender();
    updateGoToLastButton();
    if (event.type !== "stroke.append" && event.type !== "stroke.begin") updateUndoButtons();
  },
  onPresence: updatePresence,
  onStatus: updateConnection,
  onError: (message) => console.warn("Local Board sync:", message),
});

bindToolbar();
realtime.connect();
updateUndoButtons();
updateGoToLastButton();
updateCameraButtons();
updateZoomButton(renderer.view);

window.addEventListener("beforeunload", () => realtime.close());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && realtime.socket?.readyState === WebSocket.CLOSED) realtime.connect();
});

function sendLocalEvent(event) {
  remoteFollow.observeLocal(event);
  updateGoToLastButton();
  realtime.send(event);
}

function bindToolbar() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-tool]").forEach((item) => item.classList.toggle("active", item === button));
      input.setTool(button.dataset.tool);
    });
  });

  bindColorPicker();

  const widthInput = document.getElementById("width");
  const widthLabel = document.getElementById("widthLabel");
  widthInput.addEventListener("input", () => {
    input.setWidth(widthInput.value);
    widthLabel.textContent = widthInput.value;
  });

  document.getElementById("undo").addEventListener("click", undoLocalStroke);
  document.getElementById("redo").addEventListener("click", redoLocalStroke);
  document.getElementById("goToLast").addEventListener("click", () => remoteFollow.goToLastWritten());
  document.getElementById("zoomReset").addEventListener("click", () => renderer.resetZoom());
  document.getElementById("autoFollow").addEventListener("click", () => {
    remoteFollow.toggleAutoFollow();
    updateCameraButtons();
  });
  document.getElementById("autoScale").addEventListener("click", () => {
    remoteFollow.toggleAutoScale();
    updateCameraButtons();
  });
  document.getElementById("exportPng").addEventListener("click", () => renderer.exportPng());
  document.getElementById("clearBoard").addEventListener("click", clearBoard);
  document.getElementById("shareRoom").addEventListener("click", copyRoomLink);
}

function bindColorPicker() {
  const trigger = document.getElementById("colorTrigger");
  const popover = document.getElementById("colorPopover");
  const swatch = document.getElementById("currentColorSwatch");
  const customColor = document.getElementById("customColor");
  const paletteButtons = [...document.querySelectorAll(".color-option[data-color]")];
  const toolbar = document.querySelector(".toolbar");

  const savedColor = loadPenColor();
  applyColor(savedColor, { persist: false, switchToPen: false });

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    popover.classList.contains("hidden") ? openPopover() : closePopover();
  });

  paletteButtons.forEach((button) => button.addEventListener("click", () => {
    applyColor(button.dataset.color);
    closePopover();
  }));
  customColor.addEventListener("input", () => applyColor(customColor.value));
  customColor.addEventListener("change", closePopover);
  document.addEventListener("pointerdown", (event) => {
    if (popover.classList.contains("hidden")) return;
    if (popover.contains(event.target) || trigger.contains(event.target)) return;
    closePopover();
  }, { capture: true });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePopover(); });
  window.addEventListener("resize", () => { if (!popover.classList.contains("hidden")) positionPopover(); });
  toolbar?.addEventListener("scroll", closePopover, { passive: true });

  function openPopover() {
    popover.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    positionPopover();
  }
  function closePopover() {
    popover.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  }
  function positionPopover() {
    const stageRect = document.getElementById("stage").getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const popoverWidth = popover.offsetWidth || 226;
    const half = popoverWidth / 2;
    const rawCenter = triggerRect.left - stageRect.left + triggerRect.width / 2;
    const center = clamp(rawCenter, half + 10, stageRect.width - half - 10);
    const bottom = Math.max(10, stageRect.bottom - triggerRect.top + 10);
    popover.style.left = `${center}px`;
    popover.style.bottom = `${bottom}px`;
  }
  function applyColor(color, { persist = true, switchToPen = true } = {}) {
    if (!isHexColor(color)) return;
    const normalized = color.toLowerCase();
    input.setColor(normalized);
    swatch.style.setProperty("--c", normalized);
    customColor.value = normalized;
    trigger.setAttribute("aria-label", `Цвет линии: ${normalized}`);
    paletteButtons.forEach((button) => button.classList.toggle("active", button.dataset.color.toLowerCase() === normalized));
    if (persist) savePenColor(normalized);
    if (switchToPen && input.tool !== "pen") document.querySelector('[data-tool="pen"]')?.click();
  }
}

function undoLocalStroke() {
  while (localUndo.length) {
    const strokeId = localUndo.pop();
    const stroke = state.getStroke(strokeId);
    if (!stroke) continue;
    localRedo.push(cloneStroke(stroke));
    const event = { type: "stroke.delete", op_id: createId(), stroke_id: strokeId };
    state.applyEvent(event, null, clientId);
    sendLocalEvent(event);
    renderer.requestRender();
    break;
  }
  updateUndoButtons();
}

function redoLocalStroke() {
  const stroke = localRedo.pop();
  if (!stroke) return;
  const event = {
    type: "stroke.restore",
    op_id: createId(),
    stroke: {
      id: stroke.id,
      color: stroke.color,
      width: stroke.width,
      pointer_type: stroke.pointer_type,
      source_zoom: stroke.source_zoom,
      points: stroke.points,
    },
  };
  state.applyEvent(event, null, clientId);
  sendLocalEvent(event);
  localUndo.push(stroke.id);
  renderer.requestRender();
  updateUndoButtons();
}

function clearBoard() {
  if (!confirm("Очистить эту доску у всех подключённых участников?")) return;
  const event = { type: "board.clear", op_id: createId() };
  state.applyEvent(event, null, clientId);
  sendLocalEvent(event);
  localUndo.length = 0;
  localRedo.length = 0;
  renderer.requestRender();
  updateUndoButtons();
  updateGoToLastButton();
}

async function copyRoomLink() {
  const button = document.getElementById("shareRoom");
  const roomUrl = `${location.origin}/b/${encodeURIComponent(boardId)}`;
  const copied = await copyText(roomUrl);
  const previous = button.textContent;
  button.textContent = copied ? "Ссылка скопирована" : "Не скопировалось";
  setTimeout(() => { button.textContent = previous; }, 1600);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
  textarea.remove();
  return copied;
}

function updateUndoButtons() {
  document.getElementById("undo").disabled = !localUndo.some((strokeId) => state.hasStroke(strokeId));
  document.getElementById("redo").disabled = localRedo.length === 0;
}
function updateGoToLastButton() { document.getElementById("goToLast").disabled = !remoteFollow.hasLastWritten(); }
function updateZoomButton(view) {
  const button = document.getElementById("zoomReset");
  if (button) button.textContent = `${Math.round((view?.zoom || 1) * 100)}%`;
}
function updateCameraButtons() {
  const follow = document.getElementById("autoFollow");
  const scale = document.getElementById("autoScale");
  follow.classList.toggle("active", remoteFollow.autoFollowEnabled);
  scale.classList.toggle("active", remoteFollow.autoScaleEnabled);
  follow.setAttribute("aria-pressed", String(remoteFollow.autoFollowEnabled));
  scale.setAttribute("aria-pressed", String(remoteFollow.autoScaleEnabled));
}

function updatePresence(count) {
  document.getElementById("participants").textContent = count === 1 ? "1 участник" : `${count} участников`;
}
function updateConnection(status) {
  const dot = document.getElementById("connectionDot");
  const text = document.getElementById("connectionText");
  const banner = document.getElementById("offlineBanner");
  dot.className = `presence-dot ${status}`;
  if (status === "online") {
    text.textContent = "Онлайн";
    banner.classList.add("hidden");
  } else if (status === "connecting") {
    text.textContent = "Подключение…";
    banner.classList.add("hidden");
  } else {
    text.textContent = "Оффлайн";
    banner.classList.remove("hidden");
  }
}

function bindRemoteFollowInteractionGuards(targetCanvas, follow) {
  const note = () => follow.noteLocalInteraction();
  targetCanvas.addEventListener("pointerdown", note, { capture: true, passive: true });
  window.addEventListener("pointermove", (event) => {
    const pressure = Number(event.pressure || 0);
    const buttons = Number(event.buttons || 0);
    if (pressure > 0 || buttons !== 0 || event.pointerType === "touch") note();
  }, { capture: true, passive: true });
  window.addEventListener("pointerup", note, { capture: true, passive: true });
  window.addEventListener("pointercancel", note, { capture: true, passive: true });
  targetCanvas.addEventListener("touchstart", note, { capture: true, passive: true });
  window.addEventListener("touchmove", note, { capture: true, passive: true });
  window.addEventListener("touchend", note, { capture: true, passive: true });
  targetCanvas.addEventListener("wheel", note, { capture: true, passive: true });
  document.querySelector(".toolbar")?.addEventListener("pointerdown", note, { capture: true, passive: true });
  document.querySelector(".board-popover")?.addEventListener("pointerdown", note, { capture: true, passive: true });
  document.querySelector(".topbar")?.addEventListener("pointerdown", note, { capture: true, passive: true });
}

function bindInputDiagnostics(targetCanvas, debug) {
  if (!debug) return;
  let lastPointerMoveLog = 0;
  let lastTouchMoveLog = 0;
  targetCanvas.addEventListener("pointerdown", (event) => debug.pointer("PD", event), { capture: true });
  window.addEventListener("pointermove", (event) => {
    const pressure = Number(event.pressure || 0);
    const buttons = Number(event.buttons || 0);
    if (pressure <= 0 && buttons === 0) return;
    const now = performance.now();
    if (now - lastPointerMoveLog < 50) return;
    lastPointerMoveLog = now;
    debug.pointer("PM-contact", event);
  }, { capture: true });
  for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, (event) => debug.pointer(type === "pointerup" ? "PU" : "PC", event), { capture: true });
  targetCanvas.addEventListener("touchstart", (event) => { for (const touch of Array.from(event.changedTouches || [])) debug.touch("TS", touch); }, { capture: true });
  window.addEventListener("touchmove", (event) => {
    const now = performance.now();
    if (now - lastTouchMoveLog < 50) return;
    lastTouchMoveLog = now;
    for (const touch of Array.from(event.changedTouches || [])) debug.touch("TM", touch);
  }, { capture: true });
  for (const type of ["touchend", "touchcancel"]) window.addEventListener(type, (event) => {
    for (const touch of Array.from(event.changedTouches || [])) debug.touch(type === "touchend" ? "TE" : "TC", touch);
  }, { capture: true });
  debug.note(`ua ${navigator.userAgent}`);
}

function loadPenColor() {
  try {
    const stored = localStorage.getItem("local-board:pen-color");
    if (isHexColor(stored)) return stored.toLowerCase();
  } catch (_) {}
  return "#111111";
}
function savePenColor(color) { try { localStorage.setItem("local-board:pen-color", color); } catch (_) {} }
function isHexColor(value) { return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function resolveBoardId() {
  const match = location.pathname.match(/^\/b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/);
  if (!match) throw new Error("Room id is missing from the URL");
  return match[1];
}
function getClientId() {
  const key = "local-board:client-id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = createId();
    sessionStorage.setItem(key, id);
  }
  return id;
}
