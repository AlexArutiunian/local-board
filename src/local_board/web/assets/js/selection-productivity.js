import {
  combinedBounds,
  hitTest,
  objectKey,
  parseItemKey,
  strokeKey,
} from "./board-geometry.js";
import { cloneBoardObject, cloneStroke } from "./board-state.js";
import { createId } from "./id.js";

const SELECTION_CLIPBOARD_MARKER = "local-board:selection-v1";

/**
 * Finishes the interaction model around SelectionController without mixing it
 * into the low-level ink engine:
 * - Select mode accepts mouse, Apple Pencil and one-finger touch;
 * - dragging anywhere inside the current blue group bounds moves the group;
 * - two fingers always promote a touch selection gesture back to pinch/pan;
 * - arbitrary stroke/image groups can copy, paste, duplicate and delete;
 * - touch devices get the same actions in a contextual bar, so Delete/Cmd keys
 *   are not required.
 */
export function installSelectionProductivity({
  selection,
  input,
  state,
  renderer,
  sendEvent,
  history = null,
  showToast = null,
}) {
  let clipboard = null;
  let positionFrame = null;

  patchSelectionGroupDrag();
  patchSelectPointerRouting();
  const bar = createSelectionBar();
  bindClipboard();
  bindKeyboard();
  bindSelectionNotifications();
  syncBar();

  return {
    copy: copySelection,
    paste: () => pastePayload(clipboard),
    duplicate: duplicateSelection,
    sync: syncBar,
  };

  function patchSelectionGroupDrag() {
    const original = selection.pointerDown.bind(selection);
    selection.pointerDown = (event, options = {}) => {
      if (!options.forceMarquee
        && !selection.isCropping()
        && !event.shiftKey
        && selection.hasSelection()
        && !selection.hitResizeHandle(event)) {
        const world = renderer.screenToWorld(event.clientX, event.clientY);
        const bounds = combinedBounds(state, selection.keys());
        const tolerance = 7 / Math.max(0.2, renderer.view.zoom);
        const hit = hitTest(state, world, 9 / Math.max(0.2, renderer.view.zoom));
        if (bounds
          && pointInBounds(world, bounds, tolerance)
          && (!hit || selection.selected.has(hit))) {
          selection.preparePointer(event, world);
          selection.mode = "pending-move";
          selection.captureOriginals();
          return true;
        }
      }
      return original(event, options);
    };
  }

  function patchSelectPointerRouting() {
    const originalPointerDown = input.onPointerDown.bind(input);
    const originalEffectiveStylusTool = input.effectiveStylusTool.bind(input);

    // Explicit Select means select for Pencil too. Outside Select the previous
    // rule stays intact: Pen still writes while a finger-selected image is open.
    input.effectiveStylusTool = () => input.tool === "select" ? "select" : originalEffectiveStylusTool();

    input.onPointerDown = (event) => {
      if (input.tool !== "select" || !["touch", "pen"].includes(event.pointerType)) {
        return originalPointerDown(event);
      }

      preventDefault(event);
      input.clearBrowserSelection();

      if (event.pointerType === "touch" && input.selectionTouchPointerId !== null) {
        input.promoteSelectionTouchToNavigation(event);
        return;
      }

      input.cancelStylusFallback();
      input.cancelTouchGesture();
      input.endMouseInteraction();
      input.finishSoftInput({ endInk: true });
      input.pencil.interrupt();
      input.finishNonInkStylus();

      selection.pointerDown(event);
      if (event.pointerType === "touch" && selection.ownsPointer(event.pointerId)) {
        input.trackSelectionTouch(event);
      }
    };
  }

  function bindSelectionNotifications() {
    const previous = selection.onSelectionChange;
    selection.onSelectionChange = (keys) => {
      previous?.(keys);
      syncBar();
    };
    window.addEventListener("resize", syncBar);
  }

  function createSelectionBar() {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.className = "image-context-bar selection-context-bar hidden";
    element.setAttribute("role", "toolbar");
    element.setAttribute("aria-label", "Действия с выделением");
    element.innerHTML = `
      <div class="image-context-normal">
        <span class="image-context-label" data-selection-count></span>
        <button type="button" data-selection-action="copy">Копировать</button>
        <button type="button" data-selection-action="paste" disabled>Вставить</button>
        <button type="button" data-selection-action="duplicate">Дубликат</button>
        <span class="image-context-separator"></span>
        <button class="danger" type="button" data-selection-action="delete">Удалить</button>
        <button type="button" data-selection-action="done">Готово</button>
      </div>
    `;
    selection.canvas.parentElement?.appendChild(element);
    element.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      renderer.cancelFollowAnimation?.();
    });
    element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-selection-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.selectionAction;
      if (action === "copy") copySelection();
      else if (action === "paste") pastePayload(clipboard);
      else if (action === "duplicate") duplicateSelection();
      else if (action === "delete") {
        selection.deleteSelected();
        showToast?.("Выделение удалено");
      } else if (action === "done") selection.clear();
      syncBar();
    });
    return element;
  }

  function syncBar() {
    if (!bar) return;
    // A single image keeps its richer image-specific context bar. This generic
    // bar is for handwriting and mixed/multi-object selections.
    const show = selection.hasSelection() && !selection.isCropping() && !selection.selectedImage();
    bar.classList.toggle("hidden", !show);
    if (!show) {
      stopPositionLoop();
      return;
    }
    const count = selection.keys().length;
    const countNode = bar.querySelector("[data-selection-count]");
    if (countNode) countNode.textContent = `${count} ${count === 1 ? "объект" : "объекта"}`;
    const paste = bar.querySelector('[data-selection-action="paste"]');
    if (paste) paste.disabled = !clipboard;
    positionBar();
    startPositionLoop();
  }

  function positionBar() {
    if (!bar || bar.classList.contains("hidden")) return;
    const bounds = combinedBounds(state, selection.keys());
    const stage = selection.canvas.parentElement;
    if (!bounds || !stage) return;
    const stageRect = stage.getBoundingClientRect();
    const topLeft = renderer.worldToScreen(bounds);
    const width = bounds.width * renderer.view.zoom;
    const height = bounds.height * renderer.view.zoom;
    const barWidth = bar.offsetWidth || 430;
    const barHeight = bar.offsetHeight || 44;
    const center = clamp(topLeft.x + width / 2, barWidth / 2 + 10, stageRect.width - barWidth / 2 - 10);
    let top = topLeft.y - barHeight - 10;
    if (top < 68) top = topLeft.y + height + 10;
    top = clamp(top, 8, Math.max(8, stageRect.height - barHeight - 8));
    bar.style.left = `${center}px`;
    bar.style.top = `${top}px`;
  }

  function startPositionLoop() {
    if (positionFrame !== null || typeof requestAnimationFrame !== "function") return;
    const step = () => {
      positionFrame = null;
      if (!bar || bar.classList.contains("hidden")) return;
      positionBar();
      positionFrame = requestAnimationFrame(step);
    };
    positionFrame = requestAnimationFrame(step);
  }

  function stopPositionLoop() {
    if (positionFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(positionFrame);
    positionFrame = null;
  }

  function copySelection({ writeSystemClipboard = true } = {}) {
    const payload = snapshotSelection(state, selection.keys());
    if (!payload.items.length) return false;
    clipboard = payload;
    if (writeSystemClipboard) writeMarker();
    syncBar();
    showToast?.(`Скопировано: ${payload.items.length}`);
    return true;
  }

  function duplicateSelection() {
    const payload = snapshotSelection(state, selection.keys());
    if (!payload.items.length) return false;
    return pastePayload(payload);
  }

  function pastePayload(payload) {
    if (!payload?.items?.length) return false;
    const offset = 28 / Math.max(0.2, renderer.view.zoom);
    const newKeys = [];

    for (const item of payload.items) {
      if (item.kind === "stroke") {
        const source = item.stroke;
        const id = createId();
        const stroke = {
          id,
          color: source.color,
          width: source.width,
          pointer_type: source.pointer_type || "pen",
          source_zoom: source.source_zoom ?? null,
          points: source.points.map((point) => ({ ...point, x: Number(point.x) + offset, y: Number(point.y) + offset })),
        };
        const event = { type: "stroke.restore", op_id: createId(), stroke };
        state.applyEvent(event, null, input.clientId);
        sendEvent(event, { recordHistory: false });
        if (history?.recordCreatedStroke) history.recordCreatedStroke(id);
        else input.pencil?.onStrokeFinished?.(id);
        newKeys.push(strokeKey(id));
      } else if (item.kind === "object") {
        const source = item.object;
        const object = cloneBoardObject(source);
        object.id = createId();
        object.x = Number(source.x) + offset;
        object.y = Number(source.y) + offset;
        delete object.author_id;
        const event = { type: "object.create", op_id: createId(), object };
        state.applyEvent(event, null, input.clientId);
        sendEvent(event);
        newKeys.push(objectKey(object.id));
      }
    }

    selection.setSelection(newKeys);
    renderer.invalidateBase();
    renderer.requestRender();
    showToast?.(`Создана копия: ${newKeys.length}`);
    return newKeys.length > 0;
  }

  function bindClipboard() {
    if (typeof document === "undefined") return;
    document.addEventListener("copy", (event) => {
      if (isEditableTarget(event.target) || selection.selectedImage() || !selection.hasSelection()) return;
      if (!copySelection({ writeSystemClipboard: false })) return;
      try {
        event.clipboardData?.setData("text/plain", SELECTION_CLIPBOARD_MARKER);
        event.preventDefault();
      } catch (_) {}
    });
    document.addEventListener("paste", (event) => {
      if (isEditableTarget(event.target) || !clipboard) return;
      const imageFiles = [...(event.clipboardData?.files || [])].filter((file) => file.type?.startsWith("image/"));
      if (imageFiles.length) return;
      const marker = event.clipboardData?.getData("text/plain") || "";
      if (marker !== SELECTION_CLIPBOARD_MARKER) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pastePayload(clipboard);
    }, { capture: true });
  }

  function bindKeyboard() {
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", (event) => {
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "d" && selection.hasSelection() && !selection.selectedImage()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        duplicateSelection();
      }
    }, { capture: true });
  }

  function writeMarker() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(SELECTION_CLIPBOARD_MARKER).catch(() => execCopyFallback());
      return;
    }
    execCopyFallback();
  }

  function execCopyFallback() {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = SELECTION_CLIPBOARD_MARKER;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    } catch (_) {}
  }
}

export function snapshotSelection(state, keys) {
  const items = [];
  for (const key of keys || []) {
    const parsed = parseItemKey(key);
    if (parsed?.kind === "stroke") {
      const stroke = state.getStroke(parsed.id);
      if (stroke) items.push({ kind: "stroke", stroke: cloneStroke(stroke) });
    } else if (parsed?.kind === "object") {
      const object = state.getObject(parsed.id);
      if (object) items.push({ kind: "object", object: cloneBoardObject(object) });
    }
  }
  return { version: 1, items };
}

export function pointInBounds(point, bounds, tolerance = 0) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x - tolerance
    && point.x <= bounds.x + bounds.width + tolerance
    && point.y >= bounds.y - tolerance
    && point.y <= bounds.y + bounds.height + tolerance;
}

function isEditableTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
}

function preventDefault(event) { if (event.cancelable) event.preventDefault(); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
