import { itemsIntersectingRect, normalizeRect } from "./board-geometry.js";

/**
 * Makes a completed marquee a first-class area selection.
 *
 * SelectionController already computes hits on pointerup, but Safari/iPad can
 * deliver a recovered end event through a different path. We snapshot the
 * marquee rectangle before pointerup mutates gesture state, recompute every
 * intersecting board item, and then commit that exact group once more. This
 * guarantees that a handwritten formula made from many independent strokes
 * becomes one actionable selection instead of a transient rectangle or a
 * single accidentally-hit stroke.
 */
export function installAreaSelection({ selection, state, renderer, productivity = null }) {
  if (!selection || selection.__areaSelectionInstalled) return null;
  selection.__areaSelectionInstalled = true;

  let areaBounds = null;

  const originalSetSelection = selection.setSelection.bind(selection);
  selection.setSelection = (keys) => {
    areaBounds = null;
    selection.areaBounds = null;
    return originalSetSelection(keys);
  };

  const originalPointerUp = selection.pointerUp.bind(selection);
  selection.pointerUp = (event) => {
    const commit = captureMarqueeCommit(selection, state, renderer, event);
    const result = originalPointerUp(event);

    if (commit) {
      // Re-apply the deterministic hit set after the controller has cleared its
      // transient marquee. This also emits onSelectionChange, so the contextual
      // action bar appears in the same turn as pointerup.
      selection.setSelection(commit.keys);
      if (commit.keys.length) {
        areaBounds = commit.rect;
        selection.areaBounds = { ...commit.rect };
      }
      productivity?.sync?.();
      renderer.requestRender?.();
    }
    return result;
  };

  selection.getAreaBounds = () => areaBounds ? { ...areaBounds } : null;
  selection.clearAreaBounds = () => {
    areaBounds = null;
    selection.areaBounds = null;
  };

  return {
    getBounds: () => selection.getAreaBounds(),
    clear: () => selection.clearAreaBounds(),
  };
}

export function captureMarqueeCommit(selection, state, renderer, event) {
  if (!selection?.ownsPointer?.(event?.pointerId)) return null;
  if (selection.mode !== "marquee" || !selection.anchor) return null;

  const world = renderer.screenToWorld(event.clientX, event.clientY);
  const raw = normalizeRect({
    x1: selection.anchor.x,
    y1: selection.anchor.y,
    x2: world.x,
    y2: world.y,
  });
  if (raw.width < 0.5 || raw.height < 0.5) return null;

  // A small world-space margin makes edge-touching handwriting behave like the
  // visual marquee users expect, especially with thick Pencil strokes.
  const pad = 4 / Math.max(0.2, Number(renderer.view?.zoom || 1));
  const hitRect = {
    x: raw.x - pad,
    y: raw.y - pad,
    width: raw.width + pad * 2,
    height: raw.height + pad * 2,
  };
  const hits = itemsIntersectingRect(state, hitRect);
  const previous = selection.marqueeAdditive ? [...selection.selected] : [];
  const keys = [...new Set([...previous, ...hits])];
  return { rect: raw, keys };
}
