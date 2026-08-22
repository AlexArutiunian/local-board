import { hitTest } from "./board-geometry.js";

/**
 * Disambiguates a click from a drag in Select mode.
 *
 * Before this layer, pointerdown near any stroke immediately selected that one
 * stroke. That made it almost impossible to start a marquee around handwriting:
 * the first line under the pointer won before drag intent was known.
 *
 * New rule:
 * - press+release on an unselected item -> select that item;
 * - press on an unselected item and drag past threshold -> marquee from the
 *   original press point;
 * - press+drag on something already selected -> keep the existing group-move
 *   behavior installed by selection-productivity;
 * - Shift and forced RMB marquee keep their existing semantics.
 */
export function installSelectionDragIntent({ selection, state, renderer }) {
  if (!selection || selection.__dragIntentInstalled) return;
  selection.__dragIntentInstalled = true;

  let pendingHit = null;

  const originalPointerDown = selection.pointerDown.bind(selection);
  const originalPointerMove = selection.pointerMove.bind(selection);
  const originalPointerUp = selection.pointerUp.bind(selection);
  const originalCancelPointer = selection.cancelPointer.bind(selection);

  selection.pointerDown = (event, options = {}) => {
    pendingHit = null;

    if (options.forceMarquee || selection.isCropping?.() || event.shiftKey || selection.hitResizeHandle?.(event)) {
      return originalPointerDown(event, options);
    }

    const world = renderer.screenToWorld(event.clientX, event.clientY);
    const tolerance = 9 / Math.max(0.2, Number(renderer.view?.zoom || 1));
    const hit = hitTest(state, world, tolerance);

    // Already-selected content is draggable as a group. Let the productivity
    // wrapper decide whether the point is inside that group.
    if (!hit || selection.selected?.has(hit)) return originalPointerDown(event, options);

    // Do not select on pointerdown. We first wait to learn whether this was a
    // click or the beginning of an area drag.
    selection.preparePointer(event, world);
    selection.mode = "pending-hit-or-marquee";
    selection.marqueeAdditive = false;
    selection.pendingForceMarquee = false;
    pendingHit = hit;
    return true;
  };

  selection.pointerMove = (event) => {
    if (selection.mode !== "pending-hit-or-marquee" || !selection.ownsPointer?.(event.pointerId)) {
      return originalPointerMove(event);
    }

    if (!selection.dragThresholdReached(event)) return true;

    const world = renderer.screenToWorld(event.clientX, event.clientY);
    selection.clear();
    selection.mode = "marquee";
    pendingHit = null;
    renderer.setMarquee({
      x1: selection.anchor.x,
      y1: selection.anchor.y,
      x2: world.x,
      y2: world.y,
    });
    return true;
  };

  selection.pointerUp = (event) => {
    if (selection.mode !== "pending-hit-or-marquee" || !selection.ownsPointer?.(event.pointerId)) {
      const result = originalPointerUp(event);
      pendingHit = null;
      return result;
    }

    const hit = pendingHit;
    pendingHit = null;
    if (hit) selection.selectOnly(hit);
    renderer.setMarquee(null);
    selection.releasePointerCapture?.(event.pointerId);
    selection.finishGestureState();
    renderer.requestRender?.();
    return true;
  };

  selection.cancelPointer = () => {
    pendingHit = null;
    return originalCancelPointer();
  };
}
