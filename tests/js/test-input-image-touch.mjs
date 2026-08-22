import assert from "node:assert/strict";

globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {};
globalThis.document = {
  visibilityState: "visible",
  addEventListener() {},
};
globalThis.window = {
  addEventListener() {},
  getSelection() { return { removeAllRanges() {} }; },
};
globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
globalThis.cancelAnimationFrame = () => {};

const { InputController } = await import("../../src/local_board/web/assets/js/input-controller.js");

function touch(pointerId, x, y) {
  return {
    pointerId,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
    preventDefault() {},
  };
}

function makeHarness() {
  const image = { id: "img-1", kind: "image", x: 100, y: 100, width: 200, height: 120 };
  const state = {
    listObjects() { return [image]; },
    listStrokes() { return []; },
    applyEvent() {},
    getStroke() { return null; },
  };
  const canvas = {
    style: {},
    addEventListener() {},
    setPointerCapture() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
  };
  const renderer = {
    view: { x: 0, y: 0, zoom: 1 },
    screenToWorld(x, y) { return { x, y }; },
    panBy() {},
    zoomAt() {},
    saveView() {},
    requestRender() {},
    invalidateBase() {},
  };
  const selection = {
    selectedKey: null,
    activePointerId: null,
    mode: null,
    cancelled: 0,
    selectedImage() { return this.selectedKey === "object:img-1" ? image : null; },
    isCropping() { return false; },
    hasSelection() { return this.selectedKey !== null; },
    selectOnly(key) { this.selectedKey = key; },
    clear() { this.selectedKey = null; },
    preparePointer(event) { this.activePointerId = event.pointerId; },
    hitResizeHandle() { return false; },
    captureOriginals() {},
    ownsPointer(pointerId) { return this.activePointerId === pointerId; },
    pointerMove() {},
    pointerUp() { this.activePointerId = null; },
    cancelPointer() { this.cancelled += 1; this.activePointerId = null; },
    cancelCrop() {},
  };
  const controller = new InputController({
    canvas,
    state,
    renderer,
    selection,
    clientId: "local",
    sendEvent() {},
    onStrokeFinished() {},
  });
  return { controller, selection };
}

{
  const { controller, selection } = makeHarness();
  controller.onPointerDown(touch(1, 150, 140));
  assert.equal(selection.selectedKey, "object:img-1", "one-finger tap on an image must select it");
  assert.equal(selection.mode, "pending-move", "the same finger may drag the selected image");
  assert.equal(controller.selectionTouchPointerId, 1);

  controller.onPointerEnd({ ...touch(1, 150, 140), buttons: 0 });
  assert.equal(controller.selectionTouchPointerId, null);
  assert.equal(selection.selectedKey, "object:img-1", "releasing a tap keeps image editing open");
}

{
  const { controller, selection } = makeHarness();
  controller.onPointerDown(touch(1, 150, 140));
  controller.onPointerDown(touch(2, 340, 240));
  assert.equal(selection.cancelled, 1, "second finger must cancel only the current object drag");
  assert.equal(controller.touchPointers.size, 2, "both fingers must immediately become pinch/pan contacts");
  assert.equal(selection.selectedKey, "object:img-1", "pinch keeps the image selected for later editing");
}

{
  const { controller, selection } = makeHarness();
  selection.selectedKey = "object:img-1";
  controller.setTool("select");
  assert.equal(controller.effectiveStylusTool(), "pen", "Pencil remains a writing tool while a finger-selected image is active");

  controller.onPointerDown(touch(3, 20, 20));
  assert.equal(selection.selectedKey, null, "touching empty canvas exits image editing");
  assert.equal(controller.touchPointers.has(3), true, "the same empty-canvas touch still starts normal navigation");
}

{
  const { controller, selection } = makeHarness();
  controller.setDirectInkEnabled(true);
  controller.setTool("pen");
  let started = null;
  controller.startSoftInk = (event, pointerType) => { started = { event, pointerType }; };

  controller.onPointerDown(touch(4, 150, 140));
  assert.equal(started?.pointerType, "touch", "explicit finger-ink mode must write even directly over an image");
  assert.equal(selection.selectedKey, null, "finger ink over an image must not unexpectedly enter image editing");
}

console.log("Input image-touch tests passed");
