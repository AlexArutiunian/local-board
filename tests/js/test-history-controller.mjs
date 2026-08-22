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

function image(id = "img-1") {
  return {
    id,
    kind: "image",
    x: 20,
    y: 30,
    width: 320,
    height: 180,
    src: "/api/boards/1234/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    name: "task.png",
    crop_x: 0.1,
    crop_y: 0.15,
    crop_width: 0.75,
    crop_height: 0.7,
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
  const created = { type: "object.create", op_id: "create-image", object: image("photo") };
  apply(state, created);
  history.observeLocalEvent(created);

  const undoInsert = history.undo();
  assert.equal(undoInsert.type, "object.delete");
  assert.equal(undoInsert.object_id, "photo");
  apply(state, undoInsert);
  assert.equal(state.hasObject("photo"), false, "undo after image insertion removes the image");

  const redoInsert = history.redo();
  assert.equal(redoInsert.type, "object.create");
  assert.equal(redoInsert.object.id, "photo");
  apply(state, redoInsert);
  assert.equal(state.hasObject("photo"), true, "redo restores an inserted image");
}

{
  const state = new BoardState();
  const history = new LocalHistoryController({ state });
  apply(state, { type: "object.create", object: image("deleted-photo") });

  const deletion = { type: "object.delete", op_id: "delete-image", object_id: "deleted-photo" };
  apply(state, deletion);
  assert.equal(state.hasObject("deleted-photo"), false);
  assert.equal(state.getDeletedObject("deleted-photo").crop_width, 0.75);
  history.observeLocalEvent(deletion);

  const undoDelete = history.undo();
  assert.equal(undoDelete.type, "object.create");
  assert.equal(undoDelete.object.id, "deleted-photo");
  assert.equal(undoDelete.object.crop_x, 0.1);
  apply(state, undoDelete);
  assert.equal(state.hasObject("deleted-photo"), true, "undo must restore the deleted image");

  const redoDelete = history.redo();
  assert.equal(redoDelete.type, "object.delete");
  assert.equal(redoDelete.object_id, "deleted-photo");
  apply(state, redoDelete);
  assert.equal(state.hasObject("deleted-photo"), false, "redo must delete the image again");
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
