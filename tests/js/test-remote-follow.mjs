import assert from "node:assert/strict";

import {
  RemoteFollowController,
  computeFollowDelta,
  matchedSourceZoom,
} from "../../src/local_board/web/assets/js/remote-follow.js";

function makeRenderer() {
  const moves = [];
  return {
    view: { x: 0, y: 0, zoom: 1 },
    moves,
    worldToScreen(point) { return { ...point }; },
    getViewportSize() { return { width: 1000, height: 700 }; },
    smoothFocusWorldPoint(point, options) {
      moves.push({ point: { ...point }, ...options });
      return true;
    },
    cancelFollowAnimation() {},
  };
}

{
  const centered = computeFollowDelta({ point: { x: 500, y: 350 }, width: 1000, height: 700 });
  assert.equal(centered.needed, false, "writer inside the safe viewport must not move the camera");
}

{
  const beyondRight = computeFollowDelta({ point: { x: 970, y: 350 }, width: 1000, height: 700 });
  assert.equal(beyondRight.needed, true);
  assert.ok(beyondRight.dx < 0, "camera must pan left to reveal content to the right");
  assert.equal(beyondRight.dy, 0);
}

{
  const nearToolbar = computeFollowDelta({ point: { x: 500, y: 670 }, width: 1000, height: 700 });
  assert.equal(nearToolbar.needed, true);
  assert.ok(nearToolbar.dy < 0, "camera must reveal writing hidden by the bottom toolbar area");
}

{
  assert.equal(matchedSourceZoom(1, 0.5), 0.5, "large source scale difference must be matched");
  assert.equal(matchedSourceZoom(1, 0.95), 1, "tiny source scale difference should not cause camera breathing");
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local", idleGraceMs: 1000 });

  follow.observe({
    type: "stroke.begin",
    stroke: { id: "s1", source_zoom: 0.6, points: [{ x: 980, y: 350 }] },
  }, "remote-a", 100);
  assert.equal(renderer.moves.length, 1);
  assert.equal(renderer.moves[0].zoom, 0.6);

  follow.noteLocalInteraction(200);
  follow.observe({ type: "stroke.append", stroke_id: "s1", points: [{ x: 990, y: 360 }] }, "remote-a", 250);
  assert.equal(renderer.moves.length, 1);

  follow.observe({ type: "stroke.append", stroke_id: "s1", points: [{ x: 995, y: 370 }] }, "remote-a", 1300);
  assert.equal(renderer.moves.length, 2);
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });
  follow.setAutoScaleEnabled(false);
  follow.setAutoFollowEnabled(true);
  follow.observe({
    type: "stroke.begin",
    stroke: { id: "pan-only", source_zoom: 0.5, points: [{ x: 980, y: 350 }] },
  }, "remote", 100);
  assert.equal(renderer.moves.length, 1, "follow remains active when scale matching is off");
  assert.equal(renderer.moves[0].zoom, 1, "disabled auto-scale must preserve local zoom");
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });
  follow.setAutoFollowEnabled(false);
  follow.setAutoScaleEnabled(true);
  follow.observe({
    type: "stroke.begin",
    stroke: { id: "scale-only", source_zoom: 0.5, points: [{ x: 980, y: 350 }] },
  }, "remote", 100);
  assert.equal(renderer.moves.length, 1, "auto-scale can operate without positional following");
  assert.equal(renderer.moves[0].zoom, 0.5);
  assert.equal(renderer.moves[0].screenX, 980, "scale-only keeps the writing head at its current screen position");
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });
  follow.setAutoFollowEnabled(false);
  follow.setAutoScaleEnabled(false);
  follow.observe({
    type: "stroke.begin",
    stroke: { id: "none", source_zoom: 0.5, points: [{ x: 980, y: 350 }] },
  }, "remote", 100);
  assert.equal(renderer.moves.length, 0, "both camera assists can be completely disabled");
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });
  follow.observe({ type: "stroke.begin", stroke: { id: "a", points: [{ x: 980, y: 300 }] } }, "remote-a", 0);
  follow.observe({ type: "stroke.append", stroke_id: "b", points: [{ x: 10, y: 300 }] }, "remote-b", 200);
  assert.equal(renderer.moves.length, 1);
  follow.observe({ type: "stroke.begin", stroke: { id: "b", points: [{ x: 10, y: 300 }] } }, "remote-b", 250);
  assert.equal(renderer.moves.length, 2);
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });
  follow.observeLocal({ type: "stroke.begin", stroke: { id: "mine", source_zoom: 0.72, points: [{ x: 100, y: 120 }] } });
  follow.observeLocal({ type: "stroke.append", stroke_id: "mine", points: [{ x: 220, y: 240 }] });
  assert.equal(follow.hasLastWritten(), true);
  assert.equal(follow.goToLastWritten(), true);
  assert.equal(renderer.moves.at(-1).point.x, 220);
  assert.equal(renderer.moves.at(-1).point.y, 240);
  assert.equal(renderer.moves.at(-1).zoom, 0.72);
}

{
  const renderer = makeRenderer();
  const follow = new RemoteFollowController({ renderer, localClientId: "local" });
  follow.seedLastFromStrokes([
    { id: "old", source_zoom: 0.8, points: [{ x: 1, y: 2 }] },
    { id: "new", source_zoom: 0.55, points: [{ x: 7, y: 8 }, { x: 9, y: 10 }] },
  ]);
  follow.goToLastWritten();
  assert.deepEqual(renderer.moves.at(-1).point, { x: 9, y: 10 });
  assert.equal(renderer.moves.at(-1).zoom, 0.55);
}

console.log("Remote follow tests passed");
