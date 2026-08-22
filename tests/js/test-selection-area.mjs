import assert from "node:assert/strict";

const { captureMarqueeCommit, installAreaSelection } = await import(
  "../../src/local_board/web/assets/js/selection-area.js"
);

function stroke(id, x1, y1, x2, y2) {
  return {
    id,
    width: 4,
    points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
  };
}

const strokes = [
  stroke("s1", 20, 20, 35, 35),
  stroke("s2", 50, 30, 72, 34),
  stroke("s3", 80, 65, 100, 70),
  stroke("outside", 220, 220, 240, 240),
];
const state = {
  listStrokes() { return strokes; },
  listObjects() { return []; },
  getStroke(id) { return strokes.find((item) => item.id === id) || null; },
  getObject() { return null; },
  hasStroke(id) { return Boolean(this.getStroke(id)); },
  hasObject() { return false; },
};
const renderer = {
  view: { zoom: 1 },
  screenToWorld(x, y) { return { x, y }; },
  requestRender() {},
};

{
  const selection = {
    activePointerId: 7,
    mode: "marquee",
    anchor: { x: 10, y: 10 },
    marqueeAdditive: false,
    selected: new Set(),
    ownsPointer(id) { return id === this.activePointerId; },
  };
  const commit = captureMarqueeCommit(selection, state, renderer, {
    pointerId: 7,
    clientX: 120,
    clientY: 100,
  });
  assert.deepEqual(commit.keys.sort(), ["stroke:s1", "stroke:s2", "stroke:s3"]);
  assert.deepEqual(commit.rect, { x: 10, y: 10, width: 110, height: 90 });
}

{
  let syncCalls = 0;
  let committed = [];
  const selection = {
    __areaSelectionInstalled: false,
    activePointerId: 5,
    mode: "marquee",
    anchor: { x: 10, y: 10 },
    marqueeAdditive: false,
    selected: new Set(),
    ownsPointer(id) { return id === this.activePointerId; },
    setSelection(keys) {
      committed = [...keys];
      this.selected = new Set(keys);
    },
    pointerUp() {
      this.mode = null;
      this.activePointerId = null;
      return true;
    },
  };

  installAreaSelection({
    selection,
    state,
    renderer,
    productivity: { sync() { syncCalls += 1; } },
  });

  selection.pointerUp({ pointerId: 5, clientX: 120, clientY: 100 });
  assert.deepEqual(committed.sort(), ["stroke:s1", "stroke:s2", "stroke:s3"]);
  assert.equal(syncCalls, 1, "context toolbar must sync immediately after marquee commit");
  assert.deepEqual(selection.getAreaBounds(), { x: 10, y: 10, width: 110, height: 90 });
}

console.log("Selection area tests passed");
