import { FormulaTransformController } from "./formula-transform.js";
import { InputController } from "./input-controller.js";
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

    installSelectionProductivity({
      selection: this.selection,
      input: this,
      state: this.state,
      renderer: this.renderer,
      sendEvent: this.sendEvent,
      history,
      showToast: showBoardToast,
    });

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
