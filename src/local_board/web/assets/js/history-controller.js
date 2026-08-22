import { cloneBoardObject, cloneStroke } from "./board-state.js";
import { createId } from "./id.js";

export class LocalHistoryController {
  constructor({ state, onChange = null }) {
    this.state = state;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  recordCreatedStroke(strokeId) {
    const stroke = this.state.getStroke(strokeId);
    if (!stroke) return false;
    this.pushAction({ kind: "stroke.create", stroke: cloneStroke(stroke) });
    return true;
  }

  observeLocalEvent(event) {
    if (!event) return false;

    if (event.type === "stroke.delete") {
      const deleted = this.state.getDeletedStroke(event.stroke_id);
      if (!deleted) return false;
      this.pushAction({ kind: "stroke.delete", stroke: cloneStroke(deleted) });
      return true;
    }

    if (event.type === "object.create") {
      const object = this.state.getObject(event.object?.id);
      if (!object) return false;
      this.pushAction({ kind: "object.create", object: cloneBoardObject(object) });
      return true;
    }

    if (event.type === "object.delete") {
      const deleted = this.state.getDeletedObject(event.object_id);
      if (!deleted) return false;
      this.pushAction({ kind: "object.delete", object: cloneBoardObject(deleted) });
      return true;
    }

    return false;
  }

  undo() {
    while (this.undoStack.length) {
      const action = this.undoStack.pop();
      const event = this.inverseEvent(action);
      if (!event) continue;
      this.redoStack.push(action);
      this.notify();
      return event;
    }
    this.notify();
    return null;
  }

  redo() {
    while (this.redoStack.length) {
      const action = this.redoStack.pop();
      const event = this.forwardEvent(action);
      if (!event) continue;
      this.undoStack.push(action);
      this.notify();
      return event;
    }
    this.notify();
    return null;
  }

  pushAction(action) {
    this.undoStack.push(action);
    this.redoStack.length = 0;
    this.notify();
  }

  inverseEvent(action) {
    if (action.kind === "stroke.create") {
      if (!this.state.hasStroke(action.stroke.id)) return null;
      return deleteStrokeEvent(action.stroke.id);
    }
    if (action.kind === "stroke.delete") {
      if (this.state.hasStroke(action.stroke.id)) return null;
      return restoreStrokeEvent(action.stroke);
    }
    if (action.kind === "object.create") {
      if (!this.state.hasObject(action.object.id)) return null;
      return deleteObjectEvent(action.object.id);
    }
    if (action.kind === "object.delete") {
      if (this.state.hasObject(action.object.id)) return null;
      return createObjectEvent(action.object);
    }
    return null;
  }

  forwardEvent(action) {
    if (action.kind === "stroke.create") {
      if (this.state.hasStroke(action.stroke.id)) return null;
      return restoreStrokeEvent(action.stroke);
    }
    if (action.kind === "stroke.delete") {
      if (!this.state.hasStroke(action.stroke.id)) return null;
      return deleteStrokeEvent(action.stroke.id);
    }
    if (action.kind === "object.create") {
      if (this.state.hasObject(action.object.id)) return null;
      return createObjectEvent(action.object);
    }
    if (action.kind === "object.delete") {
      if (!this.state.hasObject(action.object.id)) return null;
      return deleteObjectEvent(action.object.id);
    }
    return null;
  }

  notify() {
    this.onChange?.({ canUndo: this.canUndo(), canRedo: this.canRedo() });
  }
}

function deleteStrokeEvent(strokeId) {
  return { type: "stroke.delete", op_id: createId(), stroke_id: strokeId };
}

function restoreStrokeEvent(stroke) {
  return {
    type: "stroke.restore",
    op_id: createId(),
    stroke: {
      id: stroke.id,
      color: stroke.color,
      width: stroke.width,
      pointer_type: stroke.pointer_type,
      source_zoom: stroke.source_zoom,
      points: stroke.points.map((point) => ({ ...point })),
    },
  };
}

function deleteObjectEvent(objectId) {
  return { type: "object.delete", op_id: createId(), object_id: objectId };
}

function createObjectEvent(object) {
  const clone = cloneBoardObject(object);
  delete clone.author_id;
  return { type: "object.create", op_id: createId(), object: clone };
}
