import { AssetController } from "./asset-controller.js";
import { BoardState } from "./board-state.js";
import { CanvasRenderer } from "./canvas-renderer.js";
import { LocalHistoryController } from "./history-controller.js";
import { InputController } from "./input-controller.js";
import { createInputDiagnostics } from "./input-diagnostics.js";
import { RealtimeClient } from "./realtime-client.js";
import { RemoteFollowController } from "./remote-follow.js";
import { SelectionController } from "./selection-controller.js";
import { createId } from "./id.js";

const boardId = resolveBoardId();
const clientId = getClientId();
const state = new BoardState();
const canvas = document.getElementById("board");
const stage = document.getElementById("stage");
const renderer = new CanvasRenderer(canvas, state, boardId);
const remoteFollow = new RemoteFollowController({ renderer, localClientId: clientId });
const inputDebug = createInputDiagnostics();
const history = new LocalHistoryController({ state, onChange: updateUndoButtons });
let toastTimer = null;
let realtime;

document.getElementById("boardName").textContent = boardId;
bindInputDiagnostics(canvas, inputDebug);
renderer.setViewChangeListener(updateZoomButton);

const selection = new SelectionController({
  canvas,
  state,
  renderer,
  clientId,
  sendEvent: sendLocalEvent,
  onSelectionChange: updateSelectionUI,
});

const input = new InputController({
  canvas,
  state,
  renderer,
  clientId,
  selection,
  sendEvent: sendLocalEvent,
  onStrokeFinished: (strokeId) => history.recordCreatedStroke(strokeId),
});
input.setDirectInkEnabled(loadDirectInkEnabled());

new AssetController({
  boardId,
  stage,
  fileInput: document.getElementById("imageInput"),
  imageButton: document.getElementById("imageInsert"),
  state,
  renderer,
  sendEvent: sendLocalEvent,
  selection,
  onInserted: () => activateTool("select"),
  onStatus: showToast,
});

bindRemoteFollowInteractionGuards(canvas, remoteFollow);

realtime = new RealtimeClient({
  boardId,
  clientId,
  onSnapshot: (board, pendingEvents) => {
    state.applySnapshot(board);
    for (const pending of pendingEvents) state.applyEvent(pending, null, clientId);
    selection.clear();
    remoteFollow.seedLastFromStrokes(state.listStrokes());
    renderer.render();
    updateGoToLastButton();
  },
  onEvent: (event, revision, actorId) => {
    state.applyEvent(event, revision, actorId);
    remoteFollow.observe(event, actorId);
    if (["stroke.delete", "object.delete", "board.clear"].includes(event.type)) {
      selection.setSelection(selection.keys());
    }
    renderer.requestRender();
    updateGoToLastButton();
    if (event.type !== "stroke.append" && event.type !== "stroke.begin") updateUndoButtons();
  },
  onPresence: updatePresence,
  onStatus: updateConnection,
  onError: (message) => console.warn("Local Board sync:", message),
});

bindToolbar();
bindKeyboardShortcuts();
realtime.connect();
updateUndoButtons();
updateGoToLastButton();
updateCameraButtons();
updateDirectInkButton();
updateZoomButton(renderer.view);
updateSelectionUI([]);

window.addEventListener("beforeunload", () => realtime.close());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && realtime.socket?.readyState === WebSocket.CLOSED) realtime.connect();
});

function sendLocalEvent(event, { recordHistory = true } = {}) {
  if (recordHistory) history.observeLocalEvent(event);
  remoteFollow.observeLocal(event);
  updateGoToLastButton();
  realtime.send(event);
}

function bindToolbar() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => activateTool(button.dataset.tool));
  });

  bindColorPicker();
  bindMorePopover();

  const widthInput = document.getElementById("width");
  const widthLabel = document.getElementById("widthLabel");
  widthInput.addEventListener("input", () => {
    input.setWidth(widthInput.value);
    widthLabel.textContent = widthInput.value;
  });

  document.getElementById("directInk").addEventListener("click", () => {
    input.setDirectInkEnabled(!input.directInkEnabled);
    saveDirectInkEnabled(input.directInkEnabled);
    updateDirectInkButton();
    showToast(input.directInkEnabled
      ? "Рисование мышью и пальцем включено"
      : "Палец и мышь снова двигают холст");
  });

  document.getElementById("cropSelection").addEventListener("click", () => {
    activateTool("select");
    if (!selection.startCrop()) showToast("Сначала выбери одну картинку");
  });
  document.getElementById("cropApply").addEventListener("click", () => selection.applyCrop());
  document.getElementById("cropCancel").addEventListener("click", () => selection.cancelCrop());
  document.getElementById("deleteSelection").addEventListener("click", () => selection.deleteSelected());
  document.getElementById("undo").addEventListener("click", undoLocalAction);
  document.getElementById("redo").addEventListener("click", redoLocalAction);
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
  document.getElementById("exportPng").addEventListener("click", () => {
    closePopover("morePopover", "moreTrigger");
    renderer.exportPng();
  });
  document.getElementById("clearBoard").addEventListener("click", () => {
    closePopover("morePopover", "moreTrigger");
    clearBoard();
  });
  document.getElementById("shareRoom").addEventListener("click", copyRoomLink);
}

function activateTool(tool) {
  const button = document.querySelector(`[data-tool="${tool}"]`);
  if (!button) return;
  if (selection.isCropping() && tool !== "select") selection.cancelCrop();
  document.querySelectorAll("[data-tool]").forEach((item) => item.classList.toggle("active", item === button));
  input.setTool(tool);
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      event.shiftKey ? redoLocalAction() : undoLocalAction();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key === "v") activateTool("select");
    else if (key === "p") activateTool("pen");
    else if (key === "e") activateTool("eraser");
    else if (key === "h") activateTool("pan");
  });
}

function bindColorPicker() {
  const trigger = document.getElementById("colorTrigger");
  const popover = document.getElementById("colorPopover");
  const swatch = document.getElementById("currentColorSwatch");
  const customColor = document.getElementById("customColor");
  const paletteButtons = [...document.querySelectorAll(".color-option[data-color]")];
  const savedColor = loadPenColor();
  applyColor(savedColor, { persist: false, switchToPen: false });

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    popover.classList.contains("hidden") ? open() : close();
  });
  paletteButtons.forEach((button) => button.addEventListener("click", () => {
    applyColor(button.dataset.color);
    close();
  }));
  customColor.addEventListener("input", () => applyColor(customColor.value));
  customColor.addEventListener("change", close);
  bindOutsideClose(trigger, popover, close);
  window.addEventListener("resize", () => { if (!popover.classList.contains("hidden")) positionPopover(trigger, popover); });
  document.querySelector(".toolbar")?.addEventListener("scroll", close, { passive: true });

  function open() {
    closePopover("morePopover", "moreTrigger");
    popover.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    positionPopover(trigger, popover);
  }
  function close() {
    popover.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
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
    if (switchToPen) activateTool("pen");
  }
}

function bindMorePopover() {
  const trigger = document.getElementById("moreTrigger");
  const popover = document.getElementById("morePopover");
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = popover.classList.contains("hidden");
    closePopover("colorPopover", "colorTrigger");
    popover.classList.toggle("hidden", !opening);
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening) positionPopover(trigger, popover);
  });
  bindOutsideClose(trigger, popover, () => closePopover("morePopover", "moreTrigger"));
  window.addEventListener("resize", () => {
    if (!popover.classList.contains("hidden")) positionPopover(trigger, popover);
  });
}

function bindOutsideClose(trigger, popover, close) {
  document.addEventListener("pointerdown", (event) => {
    if (popover.classList.contains("hidden")) return;
    if (popover.contains(event.target) || trigger.contains(event.target)) return;
    close();
  }, { capture: true });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
}

function closePopover(popoverId, triggerId) {
  const popover = document.getElementById(popoverId);
  const trigger = document.getElementById(triggerId);
  popover?.classList.add("hidden");
  trigger?.setAttribute("aria-expanded", "false");
}

function positionPopover(trigger, popover) {
  const stageRect = stage.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const width = popover.offsetWidth || 226;
  const half = width / 2;
  const rawCenter = triggerRect.left - stageRect.left + triggerRect.width / 2;
  const center = clamp(rawCenter, half + 10, stageRect.width - half - 10);
  const bottom = Math.max(10, stageRect.bottom - triggerRect.top + 10);
  popover.style.left = `${center}px`;
  popover.style.bottom = `${bottom}px`;
}

function undoLocalAction() { applyHistoryEvent(history.undo()); }
function redoLocalAction() { applyHistoryEvent(history.redo()); }

function applyHistoryEvent(event) {
  if (!event) return;
  if (selection.isCropping()) selection.cancelCrop();
  state.applyEvent(event, null, clientId);
  sendLocalEvent(event, { recordHistory: false });
  selection.setSelection(selection.keys());
  renderer.requestRender();
  updateUndoButtons();
}

function clearBoard() {
  if (!confirm("Очистить эту доску у всех подключённых участников?")) return;
  const event = { type: "board.clear", op_id: createId() };
  state.applyEvent(event, null, clientId);
  sendLocalEvent(event, { recordHistory: false });
  history.clear();
  selection.clear();
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

function showToast(message, tone = "") {
  const toast = document.getElementById("boardToast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `board-toast ${tone}`.trim();
  if (tone !== "busy") toastTimer = setTimeout(() => toast.classList.add("hidden"), 1800);
}

function updateSelectionUI(keys) {
  const cropping = selection.isCropping();
  const deleteButton = document.getElementById("deleteSelection");
  const cropButton = document.getElementById("cropSelection");
  const cropApply = document.getElementById("cropApply");
  const cropCancel = document.getElementById("cropCancel");
  const canCrop = keys.length === 1 && isImageKey(keys[0]);
  deleteButton.classList.toggle("hidden", !keys.length || cropping);
  cropButton.classList.toggle("hidden", !canCrop || cropping);
  cropApply.classList.toggle("hidden", !cropping);
  cropCancel.classList.toggle("hidden", !cropping);
}

function isImageKey(key) {
  if (typeof key !== "string" || !key.startsWith("object:")) return false;
  return state.getObject(key.slice("object:".length))?.kind === "image";
}

function updateUndoButtons() {
  document.getElementById("undo").disabled = !history.canUndo();
  document.getElementById("redo").disabled = !history.canRedo();
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
function updateDirectInkButton() {
  const button = document.getElementById("directInk");
  button.classList.toggle("active", input.directInkEnabled);
  button.setAttribute("aria-pressed", String(input.directInkEnabled));
  button.title = input.directInkEnabled
    ? "Рисование мышью и пальцем включено"
    : "Разрешить рисование мышью и пальцем";
}
function updatePresence(count) { document.getElementById("participants").textContent = count === 1 ? "1 участник" : `${count} участников`; }
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
function loadDirectInkEnabled() {
  try { return localStorage.getItem("local-board:direct-ink") === "1"; } catch (_) { return false; }
}
function saveDirectInkEnabled(enabled) {
  try { localStorage.setItem("local-board:direct-ink", enabled ? "1" : "0"); } catch (_) {}
}
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
