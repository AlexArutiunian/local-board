const PINCH_DEADZONE = 0.012;

/**
 * Makes touch navigation robust around Select gestures:
 * - clears a stale selection touch before a new physical touch starts;
 * - a new primary touch resets impossible leftover navigation pointers;
 * - two fingers pan and pinch at the same time instead of being zoom-only;
 * - tiny distance jitter while both fingers move together does not zoom.
 */
export function installTouchNavigation(input) {
  if (!input || input.__touchNavigationInstalled) return;
  input.__touchNavigationInstalled = true;

  let twoFingerAnchor = null;

  const originalPointerDown = input.onPointerDown.bind(input);
  const originalPointerEnd = input.onPointerEnd.bind(input);
  const originalStartTouchGesture = input.startTouchGesture.bind(input);
  const originalMoveTouchGesture = input.moveTouchGesture.bind(input);

  input.onPointerDown = (event) => {
    if (event.pointerType === "touch") reconcileBeforeTouchDown(event);
    return originalPointerDown(event);
  };

  input.onPointerEnd = (event) => {
    const trackedSelectionTouch = input.selectionTouchPointerId === event.pointerId;
    const result = originalPointerEnd(event);
    // If another recovery layer already finished SelectionController.pointerUp,
    // InputController's normal ownsPointer branch can be skipped. Never leave a
    // dead first touch behind: the next finger would otherwise look like finger
    // #2 and immediately enter pinch mode.
    if (trackedSelectionTouch) input.clearSelectionTouchTracking?.();
    if (input.touchPointers.size < 2) twoFingerAnchor = null;
    return result;
  };

  input.startTouchGesture = () => {
    if (input.touchPointers.size < 2) {
      twoFingerAnchor = null;
      return originalStartTouchGesture();
    }
    twoFingerAnchor = createTwoFingerAnchor(input);
    input.panAnchor = null;
    input.pinchAnchor = twoFingerAnchor
      ? { distance: twoFingerAnchor.distance, zoom: twoFingerAnchor.zoom }
      : null;
  };

  input.moveTouchGesture = () => {
    if (input.touchPointers.size < 2) {
      twoFingerAnchor = null;
      return originalMoveTouchGesture();
    }
    if (!twoFingerAnchor) twoFingerAnchor = createTwoFingerAnchor(input);
    if (!twoFingerAnchor) return;

    const [a, b] = [...input.touchPointers.values()];
    const center = midpoint(a, b);
    const currentDistance = Math.max(1, distance(a, b));
    let ratio = currentDistance / Math.max(1, twoFingerAnchor.distance);

    // Moving two fingers together naturally changes their separation by a few
    // pixels. Treat that as pan, not as an accidental zoom.
    if (Math.abs(Math.log(Math.max(1e-6, ratio))) < PINCH_DEADZONE) ratio = 1;

    const newZoom = clamp(twoFingerAnchor.zoom * ratio, 0.2, 5);
    applyAnchoredView(input.renderer, twoFingerAnchor.world, center, newZoom);
  };

  function reconcileBeforeTouchDown(event) {
    const tracked = input.selectionTouchPointerId;
    if (tracked !== null && !input.selection?.ownsPointer?.(tracked)) {
      input.clearSelectionTouchTracking?.();
    }

    // PointerEvent.isPrimary=true means the browser considers this the first
    // active finger. If our Map still contains an older pointer, that pointer is
    // necessarily stale (usually a lost pointerup after Select on iPadOS).
    if (event.isPrimary === true
      && input.touchPointers.size
      && !input.touchPointers.has(event.pointerId)
      && input.selectionTouchPointerId === null
      && input.softPointerId === null) {
      input.touchPointers.clear();
      input.panAnchor = null;
      input.pinchAnchor = null;
      twoFingerAnchor = null;
    }
  }
}

export function computeTwoFingerView({ view, rect, startA, startB, currentA, currentB }) {
  const startCenter = midpoint(startA, startB);
  const currentCenter = midpoint(currentA, currentB);
  const startDistance = Math.max(1, distance(startA, startB));
  const currentDistance = Math.max(1, distance(currentA, currentB));
  let ratio = currentDistance / startDistance;
  if (Math.abs(Math.log(Math.max(1e-6, ratio))) < PINCH_DEADZONE) ratio = 1;
  const zoom = clamp(view.zoom * ratio, 0.2, 5);
  const world = {
    x: (startCenter.x - rect.left - view.x) / view.zoom,
    y: (startCenter.y - rect.top - view.y) / view.zoom,
  };
  return {
    x: currentCenter.x - rect.left - world.x * zoom,
    y: currentCenter.y - rect.top - world.y * zoom,
    zoom,
  };
}

function createTwoFingerAnchor(input) {
  const points = [...input.touchPointers.values()];
  if (points.length < 2) return null;
  const [a, b] = points;
  const center = midpoint(a, b);
  return {
    center,
    distance: Math.max(1, distance(a, b)),
    zoom: input.renderer.view.zoom,
    world: input.renderer.screenToWorld(center.x, center.y),
  };
}

function applyAnchoredView(renderer, world, center, zoom) {
  if (!renderer || !world) return;
  const rect = renderer.canvas.getBoundingClientRect();
  const sx = center.x - rect.left;
  const sy = center.y - rect.top;
  renderer.cancelFollowAnimation?.();
  renderer.view.zoom = zoom;
  renderer.view.x = sx - world.x * zoom;
  renderer.view.y = sy - world.y * zoom;
  renderer.invalidateBase?.();
  renderer.requestRender?.();
  renderer.emitViewChange?.();
}

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
