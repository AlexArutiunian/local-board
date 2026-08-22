import {
  combinedBounds,
  hitTest,
  itemsIntersectingRect,
  normalizeRect,
} from "./board-geometry.js";

const MOUSE_THRESHOLD = 6;
const TOUCH_THRESHOLD = 10;

/**
 * One explicit interaction state machine for Select.
 *
 * Rules:
 * - click/release selects one hit item;
 * - drag past threshold creates an AREA selection even if drag started on ink;
 * - drag inside an already selected group moves that group;
 * - area selection is first-class UI state and survives even with zero hit items;
 * - crop/resize keep the controller's existing specialized behavior.
 */
export function installSelectionInteractionV2({
  selection,
  state,
  renderer,
  productivity = null,
  showToast = null,
}) {
  if (!selection || selection.__interactionV2Installed) return null;
  selection.__interactionV2Installed = true;

  let session = null;
  let areaBounds = null;
  let positionFrame = null;

  const baseSetSelection = selection.setSelection.bind(selection);
  const baseCropPointerDown = selection.cropPointerDown.bind(selection);
  const areaBar = createAreaBar();

  selection.getAreaBounds = () => areaBounds ? { ...areaBounds } : null;
  selection.hasAreaSelection = () => Boolean(areaBounds);
  selection.getActionBounds = () => areaBounds ? { ...areaBounds } : combinedBounds(state, selection.keys());

  selection.setSelection = (keys, options = {}) => {
    if (!options?.preserveArea) clearAreaVisual();
    return baseSetSelection(keys);
  };

  selection.pointerDown = (event, { forceMarquee = false } = {}) => {
    if (selection.isCropping()) return baseCropPointerDown(event);

    const world = renderer.screenToWorld(event.clientX, event.clientY);
    const additive = Boolean(event.shiftKey);

    if (!forceMarquee && !additive && selection.hitResizeHandle(event)) {
      clearAreaVisual();
      selection.preparePointer(event, world);
      selection.mode = "resize";
      selection.captureOriginals();
      session = { kind: "resize" };
      return true;
    }

    const zoom = Math.max(0.2, Number(renderer.view?.zoom || 1));
    const hit = forceMarquee ? null : hitTest(state, world, 9 / zoom);
    const groupBounds = selection.hasSelection() ? combinedBounds(state, selection.keys()) : null;
    const insideCurrentGroup = !forceMarquee
      && !additive
      && selection.hasSelection()
      && groupBounds
      && pointInBounds(world, groupBounds, 7 / zoom)
      && (!hit || selection.selected.has(hit));

    selection.preparePointer(event, world);
    selection.marqueeAdditive = additive;
    selection.pendingForceMarquee = forceMarquee;

    session = {
      kind: insideCurrentGroup ? "pending-move" : "pending-select",
      hit,
      additive,
      forceMarquee,
    };
    selection.mode = session.kind;
    return true;
  };

  selection.pointerMove = (event) => {
    if (!selection.ownsPointer(event.pointerId) || !selection.mode) return false;

    if (selection.activePointerType === "mouse"
      && selection.requiredButtonMask !== 0
      && (Number(event.buttons || 0) & selection.requiredButtonMask) === 0) {
      selection.pointerUp(event);
      return true;
    }

    const world = renderer.screenToWorld(event.clientX, event.clientY);
    const dx = world.x - selection.anchor.x;
    const dy = world.y - selection.anchor.y;
    selection.lastDelta = { dx, dy };

    if (selection.mode === "resize") {
      selection.previewResize(dx, dy);
      return true;
    }
    if (selection.mode?.startsWith("crop:")) {
      selection.previewCrop(selection.mode.slice(5), dx, dy);
      return true;
    }

    if (selection.mode === "pending-select" || selection.mode === "pending-move") {
      if (!thresholdReached(selection, event)) return true;

      if (selection.mode === "pending-move" && !session?.forceMarquee) {
        clearAreaVisual();
        selection.mode = "move";
        selection.captureOriginals();
        selection.previewMove(dx, dy);
        return true;
      }

      // Drag intent always wins over the hit that happened under pointerdown.
      // This is the key rule that makes handwriting-area selection predictable.
      selection.mode = "marquee";
      renderer.setMarquee({ x1: selection.anchor.x, y1: selection.anchor.y, x2: world.x, y2: world.y });
      return true;
    }

    if (selection.mode === "marquee") {
      renderer.setMarquee({ x1: selection.anchor.x, y1: selection.anchor.y, x2: world.x, y2: world.y });
      return true;
    }

    if (selection.mode === "move") {
      selection.previewMove(dx, dy);
      return true;
    }

    return true;
  };

  selection.pointerUp = (event) => {
    if (!selection.ownsPointer(event.pointerId)) return false;
    const mode = selection.mode;

    if (mode === "marquee") {
      commitArea(event);
    } else if (mode === "pending-select") {
      commitClick();
    } else if (mode === "pending-move") {
      // Short press inside the current selected group keeps it selected.
    } else if (mode === "move") {
      selection.commitMove();
    } else if (mode === "resize") {
      selection.commitResize();
    }

    if (mode !== "marquee") renderer.setMarquee(null);
    selection.releasePointerCapture(event.pointerId);
    selection.finishGestureState();
    session = null;
    renderer.requestRender();
    syncAreaBar();
    productivity?.sync?.();
    return true;
  };

  const baseCancelPointer = selection.cancelPointer.bind(selection);
  selection.cancelPointer = () => {
    session = null;
    const result = baseCancelPointer();
    syncAreaBar();
    return result;
  };

  selection.clearAreaSelection = () => {
    clearAreaVisual();
    syncAreaBar();
    productivity?.sync?.();
  };

  return {
    sync: syncAreaBar,
    getBounds: () => selection.getAreaBounds(),
  };

  function commitClick() {
    clearAreaVisual();
    const hit = session?.hit || null;
    if (session?.additive) {
      if (!hit) return;
      const next = new Set(selection.selected);
      if (next.has(hit)) next.delete(hit);
      else next.add(hit);
      selection.setSelection(next);
      return;
    }
    selection.selectOnly(hit);
  }

  function commitArea(event) {
    const world = renderer.screenToWorld(event.clientX, event.clientY);
    const rect = normalizeRect({
      x1: selection.anchor.x,
      y1: selection.anchor.y,
      x2: world.x,
      y2: world.y,
    });
    if (rect.width < 0.5 || rect.height < 0.5) {
      commitClick();
      return;
    }

    const pad = 4 / Math.max(0.2, Number(renderer.view?.zoom || 1));
    const hitRect = {
      x: rect.x - pad,
      y: rect.y - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    };
    const hits = itemsIntersectingRect(state, hitRect);
    const previous = session?.additive ? [...selection.selected] : [];
    const keys = [...new Set([...previous, ...hits])];

    // Preserve the rectangle independently from how many board items hit-test
    // found. AI actions work on this exact area, not on a guessed stroke list.
    baseSetSelection(keys);
    areaBounds = { ...rect };
    selection.areaBounds = { ...rect };
    renderer.setMarquee(rect);

    // baseSetSelection notified listeners before areaBounds existed; notify once
    // more now so area-aware UI can appear in the same pointerup turn.
    selection.onSelectionChange?.(selection.keys());
    syncAreaBar();
    showToast?.(keys.length ? `Выделена область: ${keys.length}` : "Выделена область");
  }

  function clearAreaVisual() {
    areaBounds = null;
    selection.areaBounds = null;
    renderer.setMarquee(null);
    areaBar?.classList.add("hidden");
    stopPositionLoop();
  }

  function createAreaBar() {
    if (typeof document === "undefined") return null;
    const bar = document.createElement("div");
    bar.className = "image-context-bar area-context-bar hidden";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Действия с выделенной областью");
    bar.innerHTML = `
      <div class="image-context-normal">
        <span class="image-context-label" data-area-count>Область</span>
        <button type="button" data-area-action="copy">Копировать</button>
        <button type="button" data-area-action="duplicate">Дубликат</button>
        <span class="image-context-separator"></span>
        <button class="danger" type="button" data-area-action="delete">Удалить</button>
        <button type="button" data-area-action="done">Готово</button>
      </div>
    `;
    selection.canvas.parentElement?.appendChild(bar);
    bar.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      renderer.cancelFollowAnimation?.();
    });
    bar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-area-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.areaAction;
      if (action === "copy") productivity?.copy?.();
      else if (action === "duplicate") productivity?.duplicate?.();
      else if (action === "delete") selection.deleteSelected();
      else if (action === "done") selection.clear();
      syncAreaBar();
    });
    return bar;
  }

  function syncAreaBar() {
    if (!areaBar) return;
    const show = Boolean(areaBounds) && !selection.isCropping();
    areaBar.classList.toggle("hidden", !show);

    // Area owns the contextual UI. Hide object/group bars that may have been
    // shown by baseSetSelection before areaBounds was committed.
    if (show) {
      selection.contextBar?.classList.add("hidden");
      document.querySelector(".selection-context-bar")?.classList.add("hidden");
    }

    if (!show) {
      stopPositionLoop();
      return;
    }

    const count = selection.keys().length;
    const label = areaBar.querySelector("[data-area-count]");
    if (label) label.textContent = count ? `Область · ${count}` : "Область";
    for (const action of ["copy", "duplicate", "delete"]) {
      const button = areaBar.querySelector(`[data-area-action="${action}"]`);
      if (button) button.disabled = count === 0;
    }
    positionAreaBar();
    startPositionLoop();
  }

  function positionAreaBar() {
    if (!areaBar || !areaBounds || areaBar.classList.contains("hidden")) return;
    const stage = selection.canvas.parentElement;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const topLeft = renderer.worldToScreen(areaBounds);
    const width = areaBounds.width * renderer.view.zoom;
    const height = areaBounds.height * renderer.view.zoom;
    const barWidth = areaBar.offsetWidth || 540;
    const barHeight = areaBar.offsetHeight || 44;
    const center = clamp(topLeft.x + width / 2, barWidth / 2 + 10, stageRect.width - barWidth / 2 - 10);
    let top = topLeft.y - barHeight - 10;
    if (top < 68) top = topLeft.y + height + 10;
    top = clamp(top, 8, Math.max(8, stageRect.height - barHeight - 8));
    areaBar.style.left = `${center}px`;
    areaBar.style.top = `${top}px`;
  }

  function startPositionLoop() {
    if (positionFrame !== null || typeof requestAnimationFrame !== "function") return;
    const step = () => {
      positionFrame = null;
      if (!areaBar || areaBar.classList.contains("hidden")) return;
      positionAreaBar();
      positionFrame = requestAnimationFrame(step);
    };
    positionFrame = requestAnimationFrame(step);
  }

  function stopPositionLoop() {
    if (positionFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(positionFrame);
    positionFrame = null;
  }
}

function thresholdReached(selection, event) {
  if (!selection.screenAnchor) return true;
  const threshold = selection.activePointerType === "touch" ? TOUCH_THRESHOLD : MOUSE_THRESHOLD;
  return Math.hypot(
    Number(event.clientX) - selection.screenAnchor.x,
    Number(event.clientY) - selection.screenAnchor.y,
  ) >= threshold;
}

function pointInBounds(point, bounds, tolerance = 0) {
  return point.x >= bounds.x - tolerance
    && point.x <= bounds.x + bounds.width + tolerance
    && point.y >= bounds.y - tolerance
    && point.y <= bounds.y + bounds.height + tolerance;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
