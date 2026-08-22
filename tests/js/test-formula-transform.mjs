import assert from "node:assert/strict";
import { fitFormulaBounds, placeFormulaBelowSelection } from "../../src/local_board/web/assets/js/formula-transform.js";

const bounds = { x: 100, y: 200, width: 300, height: 120 };

const wide = fitFormulaBounds(bounds, 4);
assert.ok(wide.width <= bounds.width);
assert.ok(wide.height <= bounds.height);
assert.ok(Math.abs(wide.width / wide.height - 4) < 1e-9);

const below = placeFormulaBelowSelection(bounds, 4);
assert.equal(below.width, wide.width);
assert.equal(below.height, wide.height);
assert.ok(below.y > bounds.y + bounds.height);
assert.ok(below.x >= bounds.x);
assert.ok(below.x + below.width <= bounds.x + bounds.width + 1e-9);

const tall = fitFormulaBounds(bounds, 0.5);
assert.ok(tall.height <= bounds.height);
assert.ok(tall.width <= bounds.width);
