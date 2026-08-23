import assert from "node:assert/strict";
import { isCopyShortcut, resizeImageRect } from "../../src/local_board/web/assets/js/selection-image-interactions.js";

const original = { x: 100, y: 50, width: 200, height: 100 };

{
  const next = resizeImageRect(original, "se", 50, 30, { minWidth: 10, minHeight: 10 });
  assert.deepEqual(next, { x: 100, y: 50, width: 250, height: 130 });
}

{
  const next = resizeImageRect(original, "nw", -20, -10, { minWidth: 10, minHeight: 10 });
  assert.deepEqual(next, { x: 80, y: 40, width: 220, height: 110 });
}

{
  const next = resizeImageRect(original, "ne", 40, 20, { minWidth: 10, minHeight: 10 });
  assert.deepEqual(next, { x: 100, y: 70, width: 240, height: 80 });
}

{
  const next = resizeImageRect(original, "sw", -40, 25, { minWidth: 10, minHeight: 10 });
  assert.deepEqual(next, { x: 60, y: 50, width: 240, height: 125 });
}

{
  const next = resizeImageRect(original, "se", 40, 5, {
    preserveAspect: true,
    minWidth: 10,
    minHeight: 10,
  });
  assert.equal(next.width / next.height, 2);
  assert.equal(next.x, 100);
  assert.equal(next.y, 50);
}

{
  const next = resizeImageRect(original, "nw", 500, 500, { minWidth: 24, minHeight: 24 });
  assert.equal(next.width, 24);
  assert.equal(next.height, 24);
  assert.equal(next.x, 276);
  assert.equal(next.y, 126);
}

assert.equal(isCopyShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "c" }), true);
assert.equal(isCopyShortcut({ ctrlKey: false, metaKey: true, altKey: false, key: "C" }), true);
assert.equal(isCopyShortcut({ ctrlKey: true, metaKey: false, altKey: true, key: "c" }), false);
assert.equal(isCopyShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "v" }), false);

console.log("selection image interaction tests passed");
