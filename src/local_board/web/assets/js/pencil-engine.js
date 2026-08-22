import { cloneStroke } from "./board-state.js";
import { createId } from "./id.js";

const MAX_NETWORK_BATCH_POINTS = 128;

/**
 * Owns exactly one active ink contact.
 *
 * Pointer classification happens on pointerdown. After that, pointerId is the
 * source of truth: Safari/WebKit quirks on later events must not make an active
 * Pencil session look like touch/mouse and silently drop samples.
 */
export class PencilEngine {
  constructor({
    state,
    renderer,
    sendEvent,
    clientId,
    onStrokeFinished,
    scheduleFrame = defaultScheduleFrame,
    cancelFrame = defaultCancelFrame,
  }) {
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.clientId = clientId;
    this.onStrokeFinished = onStrokeFinished;
    this.scheduleFrame = scheduleFrame;
    this.cancelFrame = cancelFrame;

    this.activePointerId = null;
    this.currentStrokeId = null;
    this.pendingNetworkPoints = [];
    this.networkFlushHandle = null;
  }

  isActive() {
    return this.activePointerId !== null;
  }

  ownsPointer(pointerId) {
    return this.activePointerId === pointerId;
  }

  begin(event, { color, width }) {
    // Never reject a fresh Pencil contact because an older WebKit session got
    // stuck without a clean pointerup. Close the old stroke and accept the new one.
    if (this.isActive()) this.end(this.activePointerId);

    this.activePointerId = event.pointerId;
    this.currentStrokeId = createId();
    this.pendingNetworkPoints.length = 0;

    const stroke = {
      id: this.currentStrokeId,
      color,
      width,
      pointer_type: "pen",
      points: [this.eventPoint(event)],
    };
    const mutation = this.withOp({ type: "stroke.begin", stroke });
    this.state.applyEvent(mutation, null, this.clientId);
    this.sendEvent(mutation);
    this.renderer.requestRender();
  }

  move(event) {
    if (!this.ownsPointer(event.pointerId) || !this.currentStrokeId) return;

    // Defensive WebKit fallback: if an up/cancel event is lost but Safari starts
    // reporting the stylus as hovering (no active button/contact), finish now.
    if (event.buttons === 0 && Number(event.pressure || 0) === 0) {
      this.end(event.pointerId);
      return;
    }

    const samples = getSamples(event);
    const points = samples
      .filter((sample) => Number.isFinite(sample.clientX) && Number.isFinite(sample.clientY))
      .map((sample) => this.eventPoint(sample));
    if (!points.length) return;

    this.state.applyEvent(
      { type: "stroke.append", stroke_id: this.currentStrokeId, points },
      null,
      this.clientId,
    );
    this.pendingNetworkPoints.push(...points);
    this.scheduleNetworkFlush();
    this.renderer.requestRender();
  }

  end(pointerId) {
    if (!this.ownsPointer(pointerId)) return false;

    const strokeId = this.currentStrokeId;
    if (strokeId) {
      this.flushPendingStrokePoints();
      const mutation = this.withOp({ type: "stroke.end", stroke_id: strokeId });
      this.state.applyEvent(mutation, null, this.clientId);
      this.sendEvent(mutation);

      const finished = this.state.getStroke(strokeId);
      if (finished) this.onStrokeFinished(cloneStroke(finished));
      this.renderer.requestRender();
    }

    this.reset();
    return true;
  }

  interrupt() {
    if (this.isActive()) this.end(this.activePointerId);
  }

  scheduleNetworkFlush() {
    if (this.networkFlushHandle !== null) return;
    this.networkFlushHandle = this.scheduleFrame(() => {
      this.networkFlushHandle = null;
      this.flushPendingStrokePoints();
    });
  }

  flushPendingStrokePoints() {
    if (!this.currentStrokeId || !this.pendingNetworkPoints.length) return;
    while (this.pendingNetworkPoints.length) {
      const points = this.pendingNetworkPoints.splice(0, MAX_NETWORK_BATCH_POINTS);
      this.sendEvent(this.withOp({
        type: "stroke.append",
        stroke_id: this.currentStrokeId,
        points,
      }));
    }
  }

  reset() {
    if (this.networkFlushHandle !== null) {
      this.cancelFrame(this.networkFlushHandle);
      this.networkFlushHandle = null;
    }
    this.pendingNetworkPoints.length = 0;
    this.activePointerId = null;
    this.currentStrokeId = null;
  }

  eventPoint(event) {
    const point = this.renderer.screenToWorld(event.clientX, event.clientY);
    const pressure = Number(event.pressure);
    return {
      x: point.x,
      y: point.y,
      pressure: Number.isFinite(pressure) && pressure > 0 ? pressure : 0.45,
    };
  }

  withOp(event) {
    return { ...event, op_id: createId() };
  }
}

function getSamples(event) {
  if (typeof event.getCoalescedEvents === "function") {
    const samples = event.getCoalescedEvents();
    if (samples?.length) return samples;
  }
  return [event];
}

function defaultScheduleFrame(callback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function defaultCancelFrame(handle) {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}
