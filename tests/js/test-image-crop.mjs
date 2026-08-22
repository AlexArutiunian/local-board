import assert from "node:assert/strict";

import { composeCropPatch } from "../../src/local_board/web/assets/js/selection-controller.js";

{
  const patch = composeCropPatch(
    { x: 100, y: 200, width: 400, height: 200, crop_x: 0, crop_y: 0, crop_width: 1, crop_height: 1 },
    { x: 200, y: 250, width: 200, height: 100 },
  );
  assert.equal(patch.x, 200);
  assert.equal(patch.width, 200);
  assert.equal(patch.crop_x, 0.25);
  assert.equal(patch.crop_y, 0.25);
  assert.equal(patch.crop_width, 0.5);
  assert.equal(patch.crop_height, 0.5);
}

{
  const patch = composeCropPatch(
    { x: 0, y: 0, width: 200, height: 100, crop_x: 0.25, crop_y: 0.1, crop_width: 0.5, crop_height: 0.8 },
    { x: 50, y: 25, width: 100, height: 50 },
  );
  assert.equal(patch.crop_x, 0.375);
  assert.equal(patch.crop_y, 0.3);
  assert.equal(patch.crop_width, 0.25);
  assert.equal(patch.crop_height, 0.4);
}

console.log("Image crop tests passed");
