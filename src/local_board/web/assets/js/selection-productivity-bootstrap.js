import { InputController } from "./input-controller.js";
import { installSelectionProductivity } from "./selection-productivity.js";

// App constructs SelectionController first and InputController second. Patching
// bind() here keeps the feature modular: the normal input event listeners are
// installed unchanged, then Select-mode routing/productivity is attached to the
// concrete pair. The listeners call this.onPointerDown dynamically, so the
// small routing wrapper installed by selection-productivity is respected.
if (!InputController.prototype.__selectionProductivityBootstrap) {
  const originalBind = InputController.prototype.bind;
  InputController.prototype.bind = function bindWithSelectionProductivity() {
    originalBind.call(this);
    if (!this.selection || this.selection.__selectionProductivityInstalled) return;
    this.selection.__selectionProductivityInstalled = true;
    installSelectionProductivity({
      selection: this.selection,
      input: this,
      state: this.state,
      renderer: this.renderer,
      sendEvent: this.sendEvent,
    });
  };
  InputController.prototype.__selectionProductivityBootstrap = true;
}
