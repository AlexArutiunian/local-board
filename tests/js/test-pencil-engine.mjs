import assert from "node:assert/strict";

import { PencilEngine, isContactEvent } from "../../src/local_board/web/assets/js/pencil-engine.js";

class FakeState {
  constructor() { this.strokes = new Map(); }
  applyEvent(event) {
    if (event.type === "stroke.begin") {
      this.strokes.set(event.stroke.id, { ...event.stroke, points: event.stroke.points.map((point) => ({ ...point })), complete: false });
    } else if (event.type === "stroke.append") {
      this.strokes.get(event.stroke_id)?.points.push(...event.points.map((point) => ({ ...point })));
    } else if (event.type === "stroke.end") {
      const stroke = this.strokes.get(event.stroke_id); if (stroke) stroke.complete = true;
    } else if (event.type === "stroke.delete") {
      this.strokes.delete(event.stroke_id);
    }
  }
  getStroke(id) { return this.strokes.get(id) || null; }
  hasStroke(id) { return this.strokes.has(id); }
}

function makeHarness() {
  const state = new FakeState();
  const sent = [];
  const finished = [];
  const scheduled = new Map();
  let nextHandle = 1;
  const renderer = {
    view: { x: 0, y: 0, zoom: 0.65 }, renderRequests: 0, baseInvalidations: 0,
    screenToWorld(x, y) { return { x, y }; }, requestRender() { this.renderRequests += 1; }, invalidateBase() { this.baseInvalidations += 1; },
  };
  const engine = new PencilEngine({
    state, renderer, clientId: "test-client", sendEvent: (event) => sent.push(event),
    onStrokeFinished: (strokeId) => finished.push(strokeId),
    scheduleFrame: (callback) => { const handle = nextHandle++; scheduled.set(handle, callback); return handle; },
    cancelFrame: (handle) => scheduled.delete(handle),
  });
  return { engine, state, sent, finished, renderer, scheduled };
}

function pointerEvent(pointerId, x = 10, y = 20, { pressure = 0.6, buttons = 1, pointerType = "pen", samples = null } = {}) {
  return { pointerId, pointerType, clientX: x, clientY: y, pressure, buttons, getCoalescedEvents: samples === null ? undefined : () => samples };
}

{
  const { engine, sent, finished, renderer } = makeHarness();
  engine.begin(pointerEvent(1), { color: "#111111", width: 4 });
  assert.equal(engine.ownsPointer(1), true);
  assert.equal(sent[0].stroke.source_zoom, 0.65);
  engine.end(1);
  engine.begin(pointerEvent(2, 30, 40), { color: "#111111", width: 4 });
  assert.equal(engine.ownsPointer(2), true);
  assert.equal(finished.length, 1);
  assert.equal(renderer.baseInvalidations, 1);
}

{
  const { engine, sent } = makeHarness();
  engine.begin(pointerEvent(5, 10, 20, { pointerType: "mouse", pressure: 0, buttons: 1 }), { color: "#111111", width: 4, pointerType: "mouse" });
  assert.equal(sent[0].stroke.pointer_type, "mouse");
  engine.end(5);
}

{
  const { engine, sent, finished } = makeHarness();
  engine.begin(pointerEvent(6, 10, 20, { pointerType: "touch", pressure: 0, buttons: 0 }), { color: "#111111", width: 4, pointerType: "touch" });
  engine.move(pointerEvent(6, 20, 30, { pointerType: "touch", pressure: 0, buttons: 0 }));
  assert.equal(engine.isActive(), true, "active touch ink must not end just because pressure is unavailable");
  engine.cancel(6);
  assert.equal(engine.isActive(), false);
  assert.equal(finished.length, 0, "pinch conversion must not create an undoable stroke");
  assert.equal(sent.at(-1).type, "stroke.delete");
}

{
  const { engine, sent } = makeHarness();
  engine.begin(pointerEvent(21), { color: "#111111", width: 4 });
  engine.move(pointerEvent(21, 15, 25, { pressure: 0, buttons: 0 }));
  assert.equal(engine.isActive(), false);
  assert.equal(sent.at(-1).type, "stroke.end");
}

{
  const { engine, state, sent, scheduled } = makeHarness();
  engine.begin(pointerEvent(31), { color: "#111111", width: 4 });
  engine.move(pointerEvent(31, 20, 30, { samples: [pointerEvent(31, 11, 21), pointerEvent(31, 12, 22), pointerEvent(31, 13, 23)] }));
  const stroke = [...state.strokes.values()][0];
  assert.equal(stroke.points.length, 4);
  assert.equal(scheduled.size, 1);
  for (const callback of [...scheduled.values()]) callback();
  assert.equal(sent.filter((event) => event.type === "stroke.append").length, 1);
}

{
  const { engine, state, sent } = makeHarness();
  const recoveryMove = pointerEvent(77, 40, 50, { samples: [pointerEvent(77, 38, 48), pointerEvent(77, 39, 49), pointerEvent(77, 40, 50)] });
  assert.equal(isContactEvent(recoveryMove), true);
  engine.recover(recoveryMove, { color: "#111111", width: 4 });
  assert.equal(engine.ownsPointer(77), true);
  assert.equal([...state.strokes.values()][0].points.length, 3);
  assert.equal(sent[0].type, "stroke.begin");
}

console.log("Pencil engine tests passed");
