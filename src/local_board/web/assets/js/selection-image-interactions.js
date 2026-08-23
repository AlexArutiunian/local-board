import { combinedBounds } from "./board-geometry.js";

const DEFAULT_MIN_SIZE = 24;

/**
 * Image-specific interaction polish kept above SelectionController:
 * - every visible corner handle is actually interactive;
 * - images resize freely on X/Y by default;
 * - Shift preserves the original aspect ratio;
 * - Ctrl/Cmd+C explicitly copies canvas selections instead of relying on the
 *   browser to dispatch a native `copy` event for a canvas.
 */
export function installSelectionImageInteractions({
  selection,
  state,
  renderer,
  productivity = null,
}) {
  if (!selection || selection.__imageInteractionsInstalled) return null;
  selection.__imageInteractionsInstalled = true;

  let resizeHandle = null;
  let preserveAspect = false;

  selection.hitResizeHandle = (event) => {
    resizeHandle = null;
    preserveAspect = false;
    if (selection.isCropping?.() || selection.keys().length !== 1 || !selection.selectedImage?.()) return false;

    const bounds = combinedBounds(state, selection.keys());
    if (!bounds) return false;

    const rect = selection.canvas.getBoundingClientRect();
    const point = {
      x: Number(event.clientX) - rect.left,
      y: Number(event.clientY) - rect.top,
    };
    const start = renderer.worldToScreen(bounds);
    const width = bounds.width * renderer.view.zoom;
    const height = bounds.height * renderer.view.zoom;
    const threshold = event.pointerType === "touch" ? 24 : event.pointerType === "pen" ? 20 : 16;

    const handles = [
      ["nw", start.x, start.y],
      ["ne", start.x + width, start.y],
      ["sw", start.x, start.y + height],
      ["se", start.x + width, start.y + height],
    ];

    let nearest = null;
    let nearestDistance = Infinity;
    for (const [name, x, y] of handles) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < nearestDistance) {
        nearest = name;
        nearestDistance = distance;
      }
    }
    if (nearestDistance > threshold) return false;

    resizeHandle = nearest;
    preserveAspect = Boolean(event.shiftKey);
    return true;
  };

  selection.previewResize = (dx, dy) => {
    if (selection.keys().length !== 1) return;
    const key = selection.keys()[0];
    const original = selection.originals.get(key);
    const object = selection.selectedImage?.();
    if (!original || !object) return;

    const minSize = Math.max(DEFAULT_MIN_SIZE / Math.max(0.2, Number(renderer.view?.zoom || 1)), 4);
    const next = resizeImageRect(original, resizeHandle || "se", dx, dy, {
      preserveAspect,
      minWidth: minSize,
      minHeight: minSize,
    });
    Object.assign(object, next);
    selection.touchBase();
  };

  const baseFinishGestureState = selection.finishGestureState.bind(selection);
  selection.finishGestureState = () => {
    resizeHandle = null;
    preserveAspect = false;
    return baseFinishGestureState();
  };

  const onKeyDown = (event) => {
    if (!isCopyShortcut(event) || isEditableTarget(event.target) || !selection.hasSelection?.()) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    if (selection.selectedImage?.()) selection.copySelectedImage?.();
    else productivity?.copy?.();
  };
  document.addEventListener("keydown", onKeyDown, { capture: true });

  return {
    currentResizeHandle: () => resizeHandle,
  };
}

export function resizeImageRect(
  original,
  handle,
  dx,
  dy,
  { preserveAspect = false, minWidth = DEFAULT_MIN_SIZE, minHeight = DEFAULT_MIN_SIZE } = {},
) {
  const x = Number(original.x) || 0;
  const y = Number(original.y) || 0;
  const width = Math.max(1e-6, Number(original.width) || 0);
  const height = Math.max(1e-6, Number(original.height) || 0);
  const safeDx = Number(dx) || 0;
  const safeDy = Number(dy) || 0;
  const west = String(handle).includes("w");
  const north = String(handle).includes("n");

  let left = west ? x + safeDx : x;
  let right = west ? x + width : x + width + safeDx;
  let top = north ? y + safeDy : y;
  let bottom = north ? y + height : y + height + safeDy;

  if (right - left < minWidth) {
    if (west) left = right - minWidth;
    else right = left + minWidth;
  }
  if (bottom - top < minHeight) {
    if (north) top = bottom - minHeight;
    else bottom = top + minHeight;
  }

  if (preserveAspect) {
    const widthScale = (right - left) / width;
    const heightScale = (bottom - top) / height;
    const minScale = Math.max(minWidth / width, minHeight / height);
    const dominant = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale;
    const scale = Math.max(minScale, dominant);
    const targetWidth = width * scale;
    const targetHeight = height * scale;

    if (west) left = right - targetWidth;
    else right = left + targetWidth;
    if (north) top = bottom - targetHeight;
    else bottom = top + targetHeight;
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function isCopyShortcut(event) {
  return Boolean(event)
    && Boolean(event.ctrlKey || event.metaKey)
    && !event.altKey
    && String(event.key || "").toLowerCase() === "c";
}

function isEditableTarget(target) {
  if (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) return true;
  if (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) return true;
  return Boolean(target?.isContentEditable);
}
