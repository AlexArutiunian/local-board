import { FormulaTransformController } from "./formula-transform.js";
import { InputController } from "./input-controller.js";
import { installAreaSelection } from "./selection-area.js";
import { installSelectionProductivity } from "./selection-productivity.js";

// Keep Select semantics modular and attach them to the concrete InputController
// instance after its normal listeners are installed. pen-ui-controls imports this
// module before app.js constructs InputController, so the prototype is patched in time.
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

    // Marquee is an area selection, not merely a visual rectangle. Recompute
    // every intersecting stroke/object on release and then let the productivity
    // toolbar react to that committed multi-item group immediately.
    installAreaSelection({
      selection: this.selection,
      state: this.state,
      renderer: this.renderer,
      productivity,
    });

    installSelectionEndRecovery(this, productivity);

    new FormulaTransformController({
      boardId: resolveBoardId(),
      selection: this.selection,
      state: this.state,
      renderer: this.renderer,
      sendEvent: this.sendEvent,
      clientId: this.clientId,
      showToast: showBoardToast,
    });
  };
  InputController.prototype.__selectionProductivityBootstrap = true;
}

// Safari/iPad can occasionally transition Pencil from contact to hover without
// delivering the pointerup that commits a marquee. The visual symptom is a
// light-blue dashed rectangle that remains on screen and never becomes a real
// selection, so no contextual actions can appear. Recover that edge by treating
// a no-contact Pencil move (pressure=0/buttons=0) or a lost pointer capture as
// the end of the current Select gesture.
function installSelectionEndRecovery(input, productivity) {
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
