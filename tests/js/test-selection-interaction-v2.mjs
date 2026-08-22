import assert from "node:assert/strict";
import { installSelectionInteractionV2 } from "../../src/local_board/web/assets/js/selection-interaction-v2.js";

function stroke(id, x1, y1, x2, y2) {
  return {
    id,
    width: 4,
    points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
  };
}

function makeHarness(strokes = []) {
  const state = {
    listStrokes: () => strokes,
    listObjects: () => [],
    getStroke: (id) => strokes.find((item) => item.id === id) || null,
    getObject: () => null,
    hasStroke: (id) => strokes.some((item) => item.id === id),
    hasObject: () => false,
  };
  const renderer = {
    view: { zoom: 1 },
    marquee: null,
    screenToWorld: (x, y) => ({ x, y }),
    worldToScreen: (point) => ({ x: point.x, y: point.y }),
    setMarquee(rect) { this.marquee = rect; },
    requestRender() {},
  };
  const selection = {
    selected: new Set(),
    activePointerId: null,
    activePointerType: null,
    requiredButtonMask: 0,
    mode: null,
    anchor: null,
    screenAnchor: null,
    lastDelta: { dx: 0, dy: 0 },
    marqueeAdditive: false,
    pendingForceMarquee: false,
    canvas: { parentElement: null },
    contextBar: null,
    keys() { return [...this.selected]; },
    hasSelection() { return this.selected.size > 0; },
    ownsPointer(id) { return this.activePointerId === id; },
    isCropping() { return false; },
    hitResizeHandle() { return false; },
    cropPointerDown() { return false; },
    setSelection(keys) { this.selected = new Set(keys || []); this.onSelectionChange?.(this.keys()); },
    selectOnly(key) { this.setSelection(key ? [key] : []); },
    clear() { this.setSelection([]); },
    preparePointer(event, world) {
      this.activePointerId = event.pointerId;
      this.activePointerType = event.pointerType;
      this.requiredButtonMask = event.pointerType === "mouse" ? 1 : 0;
      this.anchor = world;
      this.screenAnchor = { x: event.clientX, y: event.clientY };
      this.lastDelta = { dx: 0, dy: 0 };
    },
    captureOriginals() {},
    previewMove() {},
    previewResize() {},
    previewCrop() {},
    commitMove() {},
    commitResize() {},
    releasePointerCapture() {},
    finishGestureState() {
      this.activePointerId = null;
      this.activePointerType = null;
      this.requiredButtonMask = 0;
      this.mode = null;
      this.anchor = null;
      this.screenAnchor = null;
    },
    cancelPointer() { this.finishGestureState(); renderer.setMarquee(null); },
    deleteSelected() { this.clear(); return true; },
  };
  return { state, renderer, selection };
}

function event(x, y, { id = 1, buttons = 1 } = {}) {
  return {
    pointerId: id,
    pointerType: "mouse",
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
    shiftKey: false,
  };
}

{
  const h = makeHarness([
    stroke("a", 5, 5, 20, 20),
    stroke("b", 45, 20, 70, 35),
    stroke("outside", 140, 140, 160, 160),
  ]);
  installSelectionInteractionV2(h);

  // Start DIRECTLY on stroke a. Drag intent must still become an area.
  h.selection.pointerDown(event(8, 8));
  h.selection.pointerMove(event(80, 60));
  assert.equal(h.selection.mode, "marquee");
  h.selection.pointerUp(event(80, 60, { buttons: 0 }));

  assert.deepEqual(new Set(h.selection.keys()), new Set(["stroke:a", "stroke:b"]));
  assert.deepEqual(h.selection.getAreaBounds(), { x: 8, y: 8, width: 72, height: 52 });
  assert.ok(h.renderer.marquee, "committed area stays visible after pointerup");
}

{
  const h = makeHarness([]);
  installSelectionInteractionV2(h);
  h.selection.pointerDown(event(10, 10));
  h.selection.pointerMove(event(90, 50));
  h.selection.pointerUp(event(90, 50, { buttons: 0 }));

  assert.equal(h.selection.hasSelection(), false);
  assert.equal(h.selection.hasAreaSelection(), true, "empty rectangle is still a first-class area selection");
  assert.deepEqual(h.selection.getAreaBounds(), { x: 10, y: 10, width: 80, height: 40 });
}

{
  const h = makeHarness([stroke("single", 0, 0, 30, 0)]);
  installSelectionInteractionV2(h);
  h.selection.pointerDown(event(10, 0));
  h.selection.pointerUp(event(10, 0, { buttons: 0 }));
  assert.deepEqual(h.selection.keys(), ["stroke:single"], "short click still selects exactly one stroke");
  assert.equal(h.selection.hasAreaSelection(), false);
}

console.log("selection interaction v2 tests passed");
