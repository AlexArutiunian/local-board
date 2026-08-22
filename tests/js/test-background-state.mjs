import assert from "node:assert/strict";

import { normalizeBackground } from "../../src/local_board/web/assets/js/background-presets.js";
import { BoardState } from "../../src/local_board/web/assets/js/board-state.js";

assert.deepEqual(normalizeBackground(null), { pattern: "dots", tone: "white" });
assert.deepEqual(normalizeBackground({ pattern: "ruled", tone: "blue" }), { pattern: "ruled", tone: "blue" });
assert.deepEqual(normalizeBackground({ pattern: "nope", tone: "nope" }), { pattern: "dots", tone: "white" });

const state = new BoardState();
state.applySnapshot({ revision: 1, background: { pattern: "grid", tone: "warm" }, strokes: [], objects: [] });
assert.deepEqual(state.background, { pattern: "grid", tone: "warm" });
const generation = state.baseGeneration;
state.applyEvent({ type: "board.background", background: { pattern: "cornell", tone: "green" } });
assert.deepEqual(state.background, { pattern: "cornell", tone: "green" });
assert.equal(state.baseGeneration, generation + 1);

console.log("Background state tests passed");
