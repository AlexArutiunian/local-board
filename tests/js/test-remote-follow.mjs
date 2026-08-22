import assert from "node:assert/strict";

import {
  RemoteFollowController,
  computeFollowDelta,
} from "../../src/local_board/web/assets/js/remote-follow.js";

{
  const centered = computeFollowDelta({
    point: { x: 500, y: 350 },
    width: 1000,
    height: 700,
  });
  assert.equal(centered.needed, false, "writer inside the safe viewport must not move the camera");
}

{
  const beyondRight = computeFollowDelta({
    point: { x: 970, y: 350 },
    width: 1000,
    height: 700,
  });
  assert.equal(beyondRight.needed, true);
  assert.ok(beyondRight.dx < 0, "camera must pan left to reveal content to the right");
  assert.equal(beyondRight.dy, 0);
}

{
  const nearToolbar = computeFollowDelta({
    point: { x: 500, y: 670 },
    width: 1000,
    height: 700,
  });
  assert.equal(nearToolbar.needed, true);
  assert.ok(nearToolbar.dy < 0, "camera must reveal writing hidden by the bottom toolbar area");
}

{
  const pans = [];
  const renderer = {
    worldToScreen(point) { return { ...point }; },
    getViewportSize() { return { width: 1000, height: 700 }; },
    smoothPanBy(dx, dy) { pans.push({ dx, dy }); },
    cancelFollowAnimation() {},
  };
  const follow = new RemoteFollowController({
    renderer,
    localClientId: "local",
    idleGraceMs: 1000,
  });

  follow.observe({
    type: "stroke.begin",
    stroke: { id: "s1", points: [{ x: 980, y: 350 }] },
  }, "remote-a", 100);
  assert.equal(pans.length, 1, "a new remote writer outside the safe area should be followed");

  follow.noteLocalInteraction(200);
  follow.observe({
    type: "stroke.append",
    stroke_id: "s1",
    points: [{ x: 990, y: 360 }],
  }, "remote-a", 250);
  assert.equal(pans.length, 1, "local interaction must temporarily suppress remote following");

  follow.observe({
    type: "stroke.append",
    stroke_id: "s1",
    points: [{ x: 995, y: 370 }],
  }, "remote-a", 1300);
  assert.equal(pans.length, 2, "following should resume after the local interaction grace period");
}

{
  const pans = [];
  const renderer = {
    worldToScreen(point) { return { ...point }; },
    getViewportSize() { return { width: 1000, height: 700 }; },
    smoothPanBy(dx, dy) { pans.push({ dx, dy }); },
    cancelFollowAnimation() {},
  };
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });

  follow.observe({
    type: "stroke.begin",
    stroke: { id: "a", points: [{ x: 980, y: 300 }] },
  }, "remote-a", 0);

  // A second writer's append alone must not make the viewport ping-pong while
  // the first writer is still active.
  follow.observe({
    type: "stroke.append",
    stroke_id: "b",
    points: [{ x: 10, y: 300 }],
  }, "remote-b", 200);
  assert.equal(pans.length, 1);

  // Explicitly beginning a new stroke is a clear focus handoff.
  follow.observe({
    type: "stroke.begin",
    stroke: { id: "b", points: [{ x: 10, y: 300 }] },
  }, "remote-b", 250);
  assert.equal(pans.length, 2);
}

console.log("Remote follow tests passed");
