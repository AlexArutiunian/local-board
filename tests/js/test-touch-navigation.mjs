import assert from "node:assert/strict";
import { computeTwoFingerView } from "../../src/local_board/web/assets/js/touch-navigation.js";

const initial = {
  view: { x: 10, y: 20, zoom: 1.5 },
  rect: { left: 0, top: 0 },
  startA: { x: 100, y: 100 },
  startB: { x: 200, y: 100 },
};

{
  const next = computeTwoFingerView({
    ...initial,
    currentA: { x: 140, y: 125 },
    currentB: { x: 240, y: 125 },
  });
  assert.equal(next.zoom, 1.5, "moving two fingers together must not zoom");
  assert.ok(Math.abs(next.x - 50) < 1e-9, "two-finger gesture must pan horizontally");
  assert.ok(Math.abs(next.y - 45) < 1e-9, "two-finger gesture must pan vertically");
}

{
  const next = computeTwoFingerView({
    ...initial,
    currentA: { x: 75, y: 100 },
    currentB: { x: 225, y: 100 },
  });
  assert.ok(next.zoom > initial.view.zoom, "increasing finger distance must zoom in");
}

console.log("Touch navigation tests passed");
