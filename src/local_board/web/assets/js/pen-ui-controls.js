export function bindPenUiControls(root = document) {
  let active = null;
  let suppressTarget = null;
  let suppressUntil = 0;

  root.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "pen") return;
    const target = actionableTarget(event.target);
    if (!target) return;
    active = { pointerId: event.pointerId, target, x: event.clientX, y: event.clientY, time: performance.now() };
  }, { capture: true, passive: true });

  root.addEventListener("pointercancel", (event) => {
    if (active?.pointerId === event.pointerId) active = null;
  }, { capture: true, passive: true });

  root.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "pen" || active?.pointerId !== event.pointerId) return;
    const target = actionableTarget(event.target);
    const started = active;
    active = null;
    if (!target || target !== started.target) return;
    if (performance.now() - started.time > 900) return;
    if (Math.hypot(event.clientX - started.x, event.clientY - started.y) > 10) return;
    if (target.matches('input[type="range"], input[type="color"], input[type="text"]')) return;
    suppressTarget = target;
    suppressUntil = performance.now() + 450;
    target.click();
  }, { capture: true, passive: true });

  root.addEventListener("click", (event) => {
    if (!suppressTarget || performance.now() > suppressUntil) {
      suppressTarget = null;
      return;
    }
    if (actionableTarget(event.target) === suppressTarget && event.detail > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressTarget = null;
    }
  }, { capture: true });
}

function actionableTarget(target) {
  if (!(target instanceof Element)) return null;
  return target.closest("button, a, input, [role='button']");
}
