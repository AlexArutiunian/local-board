import assert from "node:assert/strict";
import { installSelectionDragIntent } from "../../src/local_board/web/assets/js/selection-drag-intent.js";

const stroke = {
  id: "s1",
  width: 4,
  points: [{ x: 10, y: 10 }, { x: 80, y: 10 }],
};
const state = {
  listStrokes() { return [stroke]; },
  listObjects() { return []; },
};
let marquee = null;
const renderer = {
  view: { zoom: 1 },
  screenToWorld(x, y) { return { x, y }; },
  setMarquee(value) { marquee = value; },
  requestRender() {},
};

let selected = [];
const selection = {
  selected: new Set(),
  mode: null,
  anchor: null,
  screenAnchor: null,
  activePointerId: null,
  marqueeAdditive: false,
  pendingForceMarquee: false,
  isCropping() { return false; },
  hitResizeHandle() { return false; },
  ownsPointer(id) { return this.activePointerId === id; },
  preparePointer(event, world) {
    this.activePointerId = event.pointerId;
    this.anchor = world;
    this.screenAnchor = { x: event.clientX, y: event.clientY };
  },
  dragThresholdReached(event) {
    return Math.hypot(event.clientX - this.screenAnchor.x, event.clientY - this.screenAnchor.y) >= 6;
  },
  clear() { selected = []; this.selected.clear(); },
  selectOnly(key) { selected = [key]; this.selected = new Set([key]); },
  releasePointerCapture() {},
  finishGestureState() { this.activePointerId = null; this.mode = null; },
  cancelPointer() { this.activePointerId = null; this.mode = null; },
  pointerDown() { throw new Error("base pointerDown should not eagerly select unselected ink"); },
  pointerMove() { return false; },
  pointerUp() { return false; },
};

installSelectionDragIntent({ selection, state, renderer });

const down = { pointerId: 1, clientX: 20, clientY: 11, shiftKey: false };
selection.pointerDown(down);
assert.equal(selection.mode, "pending-hit-or-marquee");
assert.deepEqual(selected, [], "pointerdown on ink must wait for click-vs-drag intent");

selection.pointerMove({ ...down, clientX: 60, clientY: 50 });
assert.equal(selection.mode, "marquee", "drag starting on ink must become marquee");
assert.ok(marquee, "marquee should be visible after threshold");
assert.deepEqual(selected, [], "drag must not collapse to the first stroke under the pointer");

console.log("Selection drag intent tests passed");
