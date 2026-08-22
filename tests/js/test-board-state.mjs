import assert from "node:assert/strict";

import { BoardState } from "../../src/local_board/web/assets/js/board-state.js";

const state = new BoardState();
state.applySnapshot({
  revision: 1,
  strokes: [{
    id: "s1",
    color: "#111111",
    width: 4,
    pointer_type: "pen",
    points: [{ x: 10, y: 20, pressure: 0.5 }],
    complete: true,
  }],
  objects: [{
    id: "i1",
    kind: "image",
    x: 100,
    y: 120,
    width: 320,
    height: 180,
    src: "/api/boards/1234/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    name: "task.png",
  }],
});

assert.equal(state.listObjects().length, 1);
state.applyEvent({ type: "stroke.translate", stroke_id: "s1", dx: 5, dy: -3 });
assert.deepEqual(state.getStroke("s1").points[0], { x: 15, y: 17, pressure: 0.5 });

state.applyEvent({ type: "object.update", object_id: "i1", patch: { x: 150, width: 400 } });
assert.equal(state.getObject("i1").x, 150);
assert.equal(state.getObject("i1").width, 400);

state.applyEvent({
  type: "object.create",
  object: {
    id: "i2",
    kind: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    src: "/api/boards/1234/assets/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png",
  },
}, 2, "remote");
assert.equal(state.getObject("i2").author_id, "remote");
assert.deepEqual(state.listObjects().map((object) => object.id), ["i1", "i2"]);

state.applyEvent({ type: "object.reorder", object_id: "i1", position: "front" });
assert.deepEqual(state.listObjects().map((object) => object.id), ["i2", "i1"]);

state.applyEvent({ type: "object.reorder", object_id: "i1", position: "back" });
assert.deepEqual(state.listObjects().map((object) => object.id), ["i1", "i2"]);

state.applyEvent({ type: "object.delete", object_id: "i1" });
assert.equal(state.hasObject("i1"), false);

console.log("Board state tests passed");
