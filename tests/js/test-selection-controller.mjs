import assert from "node:assert/strict";

globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {};
globalThis.document = {
  addEventListener() {},
};

const { SelectionController } = await import("../../src/local_board/web/assets/js/selection-controller.js");

function makeCanvas() {
  const listeners = new Map();
  let captured = null;
  return {
    listeners,
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    setPointerCapture(pointerId) { captured = pointerId; },
    hasPointerCapture(pointerId) { return captured === pointerId; },
    releasePointerCapture(pointerId) {
      if (captured === pointerId) captured = null;
    },
    get capturedPointer() { return captured; },
  };
}

function makeState() {
  const stroke = {
    id: "s1",
    width: 4,
    points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
  };
  return {
    baseGeneration: 0,
    listStrokes() { return [stroke]; },
    listObjects() { return []; },
    getStroke(id) { return id === stroke.id ? stroke : null; },
    getObject() { return null; },
    hasStroke(id) { return id === stroke.id; },
    hasObject() { return false; },
    applyEvent() {},
  };
}

function makeRenderer() {
  return {
    view: { zoom: 1 },
    marquee: null,
    selection: new Set(),
    screenToWorld(x, y) { return { x, y }; },
    worldToScreen(point) { return { ...point }; },
    setSelection(keys) { this.selection = new Set(keys); },
    setMarquee(value) { this.marquee = value; },
    requestRender() {},
    invalidateBase() {},
  };
}

function rightMouseEvent({ x, y, buttons = 2, pointerId = 7 }) {
  return {
    pointerId,
    pointerType: "mouse",
    button: 2,
    buttons,
    clientX: x,
    clientY: y,
    shiftKey: false,
    cancelable: true,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

{
  const canvas = makeCanvas();
  const renderer = makeRenderer();
  const controller = new SelectionController({
    canvas,
    state: makeState(),
    renderer,
    sendEvent() {},
    clientId: "local",
  });

  const down = rightMouseEvent({ x: 0, y: 0 });
  canvas.listeners.get("pointerdown")[0](down);
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.equal(controller.mode, "marquee");
  assert.equal(canvas.capturedPointer, 7);

  controller.pointerMove(rightMouseEvent({ x: 30, y: 30, buttons: 2 }));
  assert.notEqual(renderer.marquee, null);

  controller.pointerUp(rightMouseEvent({ x: 30, y: 30, buttons: 0 }));
  assert.equal(controller.activePointerId, null, "RMB release must end the marquee gesture");
  assert.equal(renderer.marquee, null, "marquee rectangle must disappear after release");
  assert.deepEqual(controller.keys(), ["stroke:s1"], "only the items inside the released marquee stay selected");
  assert.equal(canvas.capturedPointer, null);
}

{
  const canvas = makeCanvas();
  const renderer = makeRenderer();
  const controller = new SelectionController({
    canvas,
    state: makeState(),
    renderer,
    sendEvent() {},
    clientId: "local",
  });

  canvas.listeners.get("pointerdown")[0](rightMouseEvent({ x: 0, y: 0, pointerId: 9 }));
  assert.equal(controller.mode, "marquee");

  // Simulate WebKit/browser losing the explicit pointerup. A move with buttons=0
  // must reconstruct the release and finish the selection instead of sticking.
  controller.pointerMove(rightMouseEvent({ x: 30, y: 30, buttons: 0, pointerId: 9 }));
  assert.equal(controller.activePointerId, null);
  assert.equal(renderer.marquee, null);
  assert.deepEqual(controller.keys(), ["stroke:s1"]);
}

console.log("Selection controller tests passed");
