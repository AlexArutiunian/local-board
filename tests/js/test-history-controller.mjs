import assert from "node:assert/strict";

import { BoardState } from "../../src/local_board/web/assets/js/board-state.js";
import { LocalHistoryController } from "../../src/local_board/web/assets/js/history-controller.js";

function stroke(id = "s1") {
  return {
    id,
    color: "#111111",
    width: 4,
    pointer_type: "pen",
    source_zoom: 1,
    points: [
      { x: 1, y: 2, pressure: 0.5 },
      { x: 3, y: 4, pressure: 0.6 },
    ],
  };
}

function apply(state, event) {
  state.applyEvent(event, null, "local");
}

{
  const state = new BoardState();
  const history = new LocalHistoryController({ state });

  apply(state, { type: "stroke.restore", stroke: stroke("drawn") });
  history.recordCreatedStroke("drawn");

  const undo = history.undo();
  assert.equal(undo.type, "stroke.delete");
  assert.equal(undo.stroke_id, "drawn");
  apply(state, undo);
  assert.equal(state.hasStroke("drawn"), false);

  const redo = history.redo();
  assert.equal(redo.type, "stroke.restore");
  assert.equal(redo.stroke.id, "drawn");
  apply(state, redo);
  assert.equal(state.hasStroke("drawn"), true);
}

{
  const state = new BoardState();
  const history = new LocalHistoryController({ state });

  apply(state, { type: "stroke.restore", stroke: stroke("erased") });
  const deletion = { type: "stroke.delete", stroke_id: "erased" };
  apply(state, deletion);
  assert.equal(state.hasStroke("erased"), false);
  assert.equal(state.getDeletedStroke("erased").points.length, 2);

  history.observeLocalEvent(deletion);

  const undoErase = history.undo();
  assert.equal(undoErase.type, "stroke.restore");
  assert.equal(undoErase.stroke.id, "erased");
  apply(state, undoErase);
  assert.equal(state.hasStroke("erased"), true, "undo must restore an erased stroke");

  const redoErase = history.redo();
  assert.equal(redoErase.type, "stroke.delete");
  assert.equal(redoErase.stroke_id, "erased");
  apply(state, redoErase);
  assert.equal(state.hasStroke("erased"), false, "redo must erase the stroke again");
}

{
  const state = new BoardState();
  const history = new LocalHistoryController({ state });

  apply(state, { type: "stroke.restore", stroke: stroke("old") });
  apply(state, { type: "stroke.delete", stroke_id: "old" });
  history.observeLocalEvent({ type: "stroke.delete", stroke_id: "old" });
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);

  history.undo();
  assert.equal(history.canRedo(), true);

  apply(state, { type: "stroke.restore", stroke: stroke("new") });
  history.recordCreatedStroke("new");
  assert.equal(history.canRedo(), false, "a new user action must clear redo history");
}

console.log("History controller tests passed");
