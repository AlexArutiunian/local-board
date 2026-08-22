import assert from "node:assert/strict";

import { PencilEngine } from "../../src/local_board/web/assets/js/pencil-engine.js";

class FakeState {
  constructor() {
    this.strokes = new Map();
  }

  applyEvent(event) {
    if (event.type === "stroke.begin") {
      this.strokes.set(event.stroke.id, {
        ...event.stroke,
        points: event.stroke.points.map((point) => ({ ...point })),
        complete: false,
      });
    } else if (event.type === "stroke.append") {
      this.strokes.get(event.stroke_id)?.points.push(...event.points.map((point) => ({ ...point })));
    } else if (event.type === "stroke.end") {
      const stroke = this.strokes.get(event.stroke_id);
      if (stroke) stroke.complete = true;
    }
  }

  getStroke(id) {
    return this.strokes.get(id) || null;
  }
}

function makeHarness() {
  const state = new FakeState();
  const sent = [];
  const finished = [];
  const scheduled = new Map();
  let nextHandle = 1;

  const renderer = {
    renderRequests: 0,
    screenToWorld(x, y) { return { x, y }; },
    requestRender() { this.renderRequests += 1; },
  };

  const engine = new PencilEngine({
    state,
    renderer,
    clientId: "test-client",
    sendEvent: (event) => sent.push(event),
    onStrokeFinished: (stroke) => finished.push(stroke),
    scheduleFrame: (callback) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => scheduled.delete(handle),
  });

  return { engine, state, sent, finished, renderer, scheduled };
}

function penEvent(pointerId, x = 10, y = 20, { pressure = 0.6, buttons = 1, samples = null } = {}) {
  return {
    pointerId,
    clientX: x,
    clientY: y,
    pressure,
    buttons,
    getCoalescedEvents: samples === null ? undefined : () => samples,
  };
}

{
  const { engine, sent, finished } = makeHarness();
  engine.begin(penEvent(1), { color: "#111111", width: 4 });
  assert.equal(engine.ownsPointer(1), true);

  engine.end(1);
  engine.begin(penEvent(2, 30, 40), { color: "#111111", width: 4 });

  assert.equal(engine.ownsPointer(2), true, "immediate next Pencil contact must be accepted");
  assert.equal(finished.length, 1);
  assert.deepEqual(sent.map((event) => event.type), ["stroke.begin", "stroke.end", "stroke.begin"]);
}

{
  const { engine, sent, finished } = makeHarness();
  engine.begin(penEvent(10), { color: "#111111", width: 4 });

  // Simulate WebKit losing the terminal event: a new pointerdown must close the
  // stale stroke rather than reject or delay the fresh contact.
  engine.begin(penEvent(11, 50, 60), { color: "#111111", width: 4 });

  assert.equal(engine.ownsPointer(11), true);
  assert.equal(finished.length, 1);
  assert.deepEqual(sent.map((event) => event.type), ["stroke.begin", "stroke.end", "stroke.begin"]);
}

{
  const { engine, sent } = makeHarness();
  engine.begin(penEvent(21), { color: "#111111", width: 4 });

  // If pointerup/cancel disappears, the first hover-like move (no button and no
  // pressure) must close the contact and prevent a permanently stuck pen state.
  engine.move(penEvent(21, 15, 25, { pressure: 0, buttons: 0 }));

  assert.equal(engine.isActive(), false);
  assert.equal(sent.at(-1).type, "stroke.end");
}

{
  const { engine, state, sent, scheduled } = makeHarness();
  engine.begin(penEvent(31), { color: "#111111", width: 4 });
  engine.move(penEvent(31, 20, 30, {
    samples: [
      penEvent(31, 11, 21),
      penEvent(31, 12, 22),
      penEvent(31, 13, 23),
    ],
  }));

  const stroke = [...state.strokes.values()][0];
  assert.equal(stroke.points.length, 4, "coalesced Pencil samples must be applied locally immediately");
  assert.equal(scheduled.size, 1, "network append should be batched to one frame");

  for (const callback of [...scheduled.values()]) callback();
  assert.equal(sent.filter((event) => event.type === "stroke.append").length, 1);
}

console.log("Pencil engine tests passed");
