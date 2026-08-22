import assert from "node:assert/strict";

globalThis.window = { addEventListener() {} };

const { installSelectionProductivity, pointInBounds, snapshotSelection } = await import(
  "../../src/local_board/web/assets/js/selection-productivity.js"
);

{
  const stroke = {
    id: "s1",
    color: "#111111",
    width: 4,
    pointer_type: "pen",
    source_zoom: 1,
    points: [{ x: 10, y: 20, pressure: 0.5 }],
  };
  const object = {
    id: "o1",
    kind: "image",
    x: 40,
    y: 50,
    width: 100,
    height: 60,
    src: "/api/boards/1234/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    name: "task.png",
    crop_x: 0,
    crop_y: 0,
    crop_width: 1,
    crop_height: 1,
  };
  const state = {
    getStroke(id) { return id === "s1" ? stroke : null; },
    getObject(id) { return id === "o1" ? object : null; },
  };
  const payload = snapshotSelection(state, ["stroke:s1", "object:o1"]);
  assert.equal(payload.items.length, 2);
  payload.items[0].stroke.points[0].x = 999;
  payload.items[1].object.x = 999;
  assert.equal(stroke.points[0].x, 10, "selection clipboard must clone handwriting");
  assert.equal(object.x, 40, "selection clipboard must clone objects");
  assert.equal(pointInBounds({ x: 50, y: 50 }, { x: 10, y: 10, width: 50, height: 50 }), true);
  assert.equal(pointInBounds({ x: 80, y: 50 }, { x: 10, y: 10, width: 50, height: 50 }), false);
}

{
  let originalCalls = 0;
  let selectionCalls = 0;
  let promoted = 0;
  let tracked = 0;

  const selection = {
    selected: new Set(),
    onSelectionChange: null,
    canvas: { parentElement: null },
    pointerDown(event) { selectionCalls += 1; this.activePointerId = event.pointerId; return true; },
    ownsPointer(id) { return this.activePointerId === id; },
    hasSelection() { return false; },
    hitResizeHandle() { return false; },
    isCropping() { return false; },
    keys() { return []; },
    selectedImage() { return null; },
  };
  const input = {
    tool: "select",
    clientId: "local",
    selectionTouchPointerId: null,
    onPointerDown() { originalCalls += 1; },
    effectiveStylusTool() { return this.tool; },
    clearBrowserSelection() {},
    cancelStylusFallback() {},
    cancelTouchGesture() {},
    endMouseInteraction() {},
    finishSoftInput() {},
    pencil: { interrupt() {} },
    finishNonInkStylus() {},
    trackSelectionTouch(event) { tracked += 1; this.selectionTouchPointerId = event.pointerId; },
    promoteSelectionTouchToNavigation() { promoted += 1; this.selectionTouchPointerId = null; },
  };
  const state = {};
  const renderer = {
    view: { zoom: 1 },
    screenToWorld(x, y) { return { x, y }; },
  };

  installSelectionProductivity({ selection, input, state, renderer, sendEvent() {} });

  const touch = (pointerId) => ({
    pointerId,
    pointerType: "touch",
    clientX: 20,
    clientY: 30,
    cancelable: true,
    preventDefault() {},
  });
  const pen = {
    pointerId: 7,
    pointerType: "pen",
    clientX: 20,
    clientY: 30,
    cancelable: true,
    preventDefault() {},
  };

  input.onPointerDown(touch(1));
  assert.equal(selectionCalls, 1, "one finger in Select must enter selection");
  assert.equal(tracked, 1, "first selection finger must be tracked for two-finger promotion");
  assert.equal(originalCalls, 0);

  input.onPointerDown(touch(2));
  assert.equal(promoted, 1, "second finger must return the gesture to navigation/pinch");

  input.onPointerDown(pen);
  assert.equal(selectionCalls, 2, "Apple Pencil in explicit Select must select, not draw");

  input.tool = "pen";
  input.onPointerDown({ ...pen, pointerId: 8 });
  assert.equal(originalCalls, 1, "outside Select the normal Pencil input path must remain intact");
}

console.log("Selection productivity tests passed");
