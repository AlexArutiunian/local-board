import assert from "node:assert/strict";

import {
  combinedBounds,
  hitTest,
  itemsIntersectingRect,
  objectKey,
  strokeKey,
} from "../../src/local_board/web/assets/js/board-geometry.js";

const stroke = {
  id: "s1",
  width: 4,
  points: [{ x: 10, y: 10 }, { x: 30, y: 30 }],
};
const image = {
  id: "i1",
  kind: "image",
  x: 100,
  y: 80,
  width: 200,
  height: 120,
};
const state = {
  listStrokes: () => [stroke],
  listObjects: () => [image],
  getStroke: (id) => id === "s1" ? stroke : null,
  getObject: (id) => id === "i1" ? image : null,
};

assert.equal(hitTest(state, { x: 20, y: 20 }, 4), strokeKey("s1"));
assert.equal(hitTest(state, { x: 150, y: 100 }, 4), objectKey("i1"));
assert.equal(hitTest(state, { x: 500, y: 500 }, 4), null);

const marquee = itemsIntersectingRect(state, { x1: 0, y1: 0, x2: 160, y2: 110 });
assert.equal(marquee.includes(strokeKey("s1")), true);
assert.equal(marquee.includes(objectKey("i1")), true);

const bounds = combinedBounds(state, [strokeKey("s1"), objectKey("i1")]);
assert.ok(bounds.x <= 10);
assert.ok(bounds.y <= 10);
assert.ok(bounds.x + bounds.width >= 300);
assert.ok(bounds.y + bounds.height >= 200);

console.log("Board geometry tests passed");
