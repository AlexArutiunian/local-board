import { BoardState, cloneStroke } from "./board-state.js";
import { CanvasRenderer } from "./canvas-renderer.js";
import { InputController } from "./input-controller.js";
import { RealtimeClient } from "./realtime-client.js";
import { createId } from "./id.js";

const boardId = resolveBoardId();
const clientId = getClientId();
const state = new BoardState();
const canvas = document.getElementById("board");
const renderer = new CanvasRenderer(canvas, state, boardId);
const localUndo = [];
const localRedo = [];

document.getElementById("boardName").textContent = boardId;

let realtime;
const input = new InputController({
  canvas,
  state,
  renderer,
  clientId,
  sendEvent: (event) => realtime.send(event),
  onStrokeFinished: (stroke) => {
    localUndo.push(cloneStroke(stroke));
    localRedo.length = 0;
    updateUndoButtons();
  },
});

realtime = new RealtimeClient({
  boardId,
  clientId,
  onSnapshot: (board, pendingEvents) => {
    state.applySnapshot(board);
    for (const pending of pendingEvents) state.applyEvent(pending, null, clientId);
    renderer.render();
  },
  onEvent: (event, revision, actorId) => {
    state.applyEvent(event, revision, actorId);
    renderer.render();
    updateUndoButtons();
  },
  onPresence: updatePresence,
  onStatus: updateConnection,
  onError: (message) => console.warn("Local Board sync:", message),
});

bindToolbar();
realtime.connect();
updateUndoButtons();

window.addEventListener("beforeunload", () => realtime.close());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && realtime.socket?.readyState === WebSocket.CLOSED) {
    realtime.connect();
  }
});

function bindToolbar() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-tool]").forEach((item) => item.classList.toggle("active", item === button));
      input.setTool(button.dataset.tool);
    });
  });

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-color]").forEach((item) => item.classList.toggle("active", item === button));
      input.setColor(button.dataset.color);
      if (input.tool !== "pen") document.querySelector('[data-tool="pen"]').click();
    });
  });

  const widthInput = document.getElementById("width");
  const widthLabel = document.getElementById("widthLabel");
  widthInput.addEventListener("input", () => {
    input.setWidth(widthInput.value);
    widthLabel.textContent = widthInput.value;
  });

  document.getElementById("undo").addEventListener("click", undoLocalStroke);
  document.getElementById("redo").addEventListener("click", redoLocalStroke);
  document.getElementById("resetView").addEventListener("click", () => renderer.resetView());
  document.getElementById("exportPng").addEventListener("click", () => renderer.exportPng());
  document.getElementById("clearBoard").addEventListener("click", clearBoard);
}

function undoLocalStroke() {
  while (localUndo.length) {
    const stroke = localUndo.pop();
    if (!state.hasStroke(stroke.id)) continue;
    localRedo.push(cloneStroke(stroke));
    const event = { type: "stroke.delete", op_id: createId(), stroke_id: stroke.id };
    state.applyEvent(event, null, clientId);
    realtime.send(event);
    renderer.render();
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
      points: stroke.points,
    },
  };
  state.applyEvent(event, null, clientId);
  realtime.send(event);
  localUndo.push(cloneStroke(stroke));
  renderer.render();
  updateUndoButtons();
}

function clearBoard() {
  if (!confirm("Очистить эту доску у всех подключённых участников?")) return;
  const event = { type: "board.clear", op_id: createId() };
  state.applyEvent(event, null, clientId);
  realtime.send(event);
  localUndo.length = 0;
  localRedo.length = 0;
  renderer.render();
  updateUndoButtons();
}

function updateUndoButtons() {
  document.getElementById("undo").disabled = !localUndo.some((stroke) => state.hasStroke(stroke.id));
  document.getElementById("redo").disabled = localRedo.length === 0;
}

function updatePresence(count) {
  const label = count === 1 ? "1 участник" : `${count} участников`;
  document.getElementById("participants").textContent = label;
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

function resolveBoardId() {
  const match = location.pathname.match(/^\/b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/);
  return match ? match[1] : "main";
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
