import { FormulaTransformController } from "./formula-transform.js";
import { InputController } from "./input-controller.js";
import { installSelectionImageInteractions } from "./selection-image-interactions.js";
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

    installSelectionImageInteractions({
      selection: this.selection,
      state: this.state,
      renderer: this.renderer,
      productivity,
    });

    const interaction = installSelectionInteractionV2({
      selection: this.selection,
      state: this.state,
      renderer: this.renderer,
      productivity,
      showToast: showBoardToast,
    });

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
    this.selection.formulaTransform = formulaTransform;
    installAreaFormulaButton(this.selection, formulaTransform);
  };
  InputController.prototype.__selectionProductivityBootstrap = true;
}

function installAreaFormulaButton(selection, formulaTransform) {
  const container = document.querySelector(".area-context-bar .image-context-normal");
  if (!container || container.querySelector("[data-area-formula]") || !formulaTransform) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.areaFormula = "true";
  button.className = "formula-transform-action";
  button.textContent = "Преобразовать формулу";
  button.title = "Распознать формулу внутри выделенной области";
  const separator = container.querySelector(".image-context-separator");
  container.insertBefore(button, separator);
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    formulaTransform.transform().catch((error) => {
      console.error("Formula transform failed:", error);
      showBoardToast(String(error?.message || error || "Не удалось преобразовать формулу"), "error");
    });
  });
}

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
      // Generic group UI updates first. Area interaction then wins and hides it.
      productivity?.sync?.();
      interaction?.sync?.();
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
