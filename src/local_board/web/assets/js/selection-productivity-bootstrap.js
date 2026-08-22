import { FormulaTransformController } from "./formula-transform.js";
import { InputController } from "./input-controller.js";
import { installSelectionInteractionV2 } from "./selection-interaction-v2.js";
import { installSelectionProductivity } from "./selection-productivity.js";
import { installTouchNavigation } from "./touch-navigation.js";

// Attach the higher-level Select behavior to each concrete InputController.
// SelectionInteractionV2 is the single owner of click-vs-drag semantics; the
// older area/drag-intent wrappers are intentionally no longer installed.
if (!InputController.prototype.__selectionProductivityBootstrap) {
  const originalBind = InputController.prototype.bind;
  InputController.prototype.bind = function bindWithSelectionProductivity() {
    originalBind.call(this);
    if (!this.selection || this.selection.__selectionProductivityInstalled) return;
    this.selection.__selectionProductivityInstalled = true;
    const history = globalThis.__localBoardHistory || null;

    const productivity = installSelectionProductivity({
      selection: this.selection,
      input: this,
      state: this.state,
      renderer: this.renderer,
      sendEvent: this.sendEvent,
      history,
      showToast: showBoardToast,
    });

    const interaction = installSelectionInteractionV2({
      selection: this.selection,
      state: this.state,
      renderer: this.renderer,
      productivity,
      showToast: showBoardToast,
    });

    // Select promotes a second finger to navigation. Keep that state clean and
    // make two-finger navigation a true pan+pinch gesture.
    installTouchNavigation(this);
    installSelectionEndRecovery(this, productivity, interaction);

    const formulaTransform = new FormulaTransformController({
      boardId: resolveBoardId(),
      selection: this.selection,
      state: this.state,
      renderer: this.renderer,
      sendEvent: this.sendEvent,
      clientId: this.clientId,
      showToast: showBoardToast,
    });
    // Area-selection toolbar is owned by SelectionInteractionV2 rather than the
    // old object toolbar. Expose the same controller so its button can call the
    // exact same OCR pipeline.
    this.selection.formulaTransform = formulaTransform;
  };
  InputController.prototype.__selectionProductivityBootstrap = true;
}

// Safari/iPad can occasionally transition Pencil from contact to hover without
// delivering pointerup. Treat no-contact hover or lost capture as release so the
// one state machine still commits the same click/area action.
function installSelectionEndRecovery(input, productivity, interaction) {
  const selection = input.selection;
  const canvas = input.canvas;
  let lastPoint = null;
  let finishing = false;

  const remember = (event) => {
    if (!selection.ownsPointer(event.pointerId)) return;
    lastPoint = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || selection.activePointerType || "mouse",
      clientX: Number(event.clientX),
      clientY: Number(event.clientY),
      pressure: Number(event.pressure || 0),
      buttons: Number(event.buttons || 0),
    };
  };

  canvas.addEventListener("pointerdown", remember, { passive: true });

  window.addEventListener("pointermove", (event) => {
    if (!selection.ownsPointer(event.pointerId)) return;
    remember(event);
    if (event.pointerType !== "pen") return;
    if (Number(event.pressure || 0) > 0 || Number(event.buttons || 0) !== 0) return;
    finish(event);
  }, { capture: true, passive: true });

  canvas.addEventListener("lostpointercapture", (event) => {
    if (!selection.ownsPointer(event.pointerId)) return;
    const fallback = lastPoint || {
      pointerId: event.pointerId,
      pointerType: selection.activePointerType || "mouse",
      clientX: Number(selection.screenAnchor?.x || 0),
      clientY: Number(selection.screenAnchor?.y || 0),
      pressure: 0,
      buttons: 0,
    };
    finish(fallback);
  }, { passive: true });

  function finish(event) {
    if (finishing || !selection.ownsPointer(event.pointerId)) return;
    finishing = true;
    try {
      selection.pointerUp(event);
      if (input.selectionTouchPointerId === event.pointerId) input.clearSelectionTouchTracking?.();
      interaction?.sync?.();
      productivity?.sync?.();
    } finally {
      finishing = false;
      lastPoint = null;
    }
  }
}

function resolveBoardId() {
  const match = location.pathname.match(/^\/b\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

let toastTimer = null;
function showBoardToast(message, type = "") {
  const node = document.getElementById("boardToast");
  if (!node) return;
  if (toastTimer) clearTimeout(toastTimer);
  node.textContent = String(message || "");
  node.classList.remove("hidden", "error", "success");
  if (type === "error") node.classList.add("error");
  else if (type === "success") node.classList.add("success");
  if (type === "busy") return;
  toastTimer = setTimeout(() => node.classList.add("hidden"), 2400);
}
