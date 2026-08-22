import { createId } from "./id.js";

const MAX_NETWORK_BATCH_POINTS = 128;

/**
 * Owns exactly one active ink contact.
 *
 * Normal path: pointerdown -> move* -> pointerup.
 * Recovery path: if WebKit drops a fast pointerdown, a contact-bearing pointermove
 * or stylus TouchEvent can reconstruct the stroke immediately.
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
    return this.beginSamples(event.pointerId, getSamples(event), { color, width });
  }

  /** Start from a move/touch sample when the browser omitted pointerdown. */
  recover(event, { color, width }) {
    return this.beginSamples(event.pointerId, getSamples(event), { color, width });
  }

  beginSamples(pointerId, samples, { color, width }) {
    if (this.isActive()) this.end(this.activePointerId);

    const usable = (samples || [])
      .filter((sample) => Number.isFinite(sample.clientX) && Number.isFinite(sample.clientY));
    if (!usable.length) return false;

    this.activePointerId = pointerId;
    this.currentStrokeId = createId();
    this.pendingNetworkPoints.length = 0;

    const firstPoint = this.eventPoint(usable[0]);
    const stroke = {
      id: this.currentStrokeId,
      color,
      width,
      pointer_type: "pen",
      source_zoom: this.renderer.view.zoom,
      points: [firstPoint],
    };
    const mutation = this.withOp({ type: "stroke.begin", stroke });
    this.state.applyEvent(mutation, null, this.clientId);
    this.sendEvent(mutation);

    if (usable.length > 1) {
      const rest = usable.slice(1).map((sample) => this.eventPoint(sample));
      this.appendPoints(rest);
    }

    this.renderer.requestRender();
    return true;
  }

  move(event) {
    if (!this.ownsPointer(event.pointerId) || !this.currentStrokeId) return;

    if (!isContactEvent(event)) {
      this.end(event.pointerId);
      return;
    }

    const points = getSamples(event)
      .filter((sample) => Number.isFinite(sample.clientX) && Number.isFinite(sample.clientY))
      .map((sample) => this.eventPoint(sample));
    if (!points.length) return;

    this.appendPoints(points);
    this.renderer.requestRender();
  }

  appendPoints(points) {
    if (!this.currentStrokeId || !points.length) return;
    this.state.applyEvent(
      { type: "stroke.append", stroke_id: this.currentStrokeId, points },
      null,
      this.clientId,
    );
    this.pendingNetworkPoints.push(...points);
    this.scheduleNetworkFlush();
  }

  end(pointerId) {
    if (!this.ownsPointer(pointerId)) return false;

    const strokeId = this.currentStrokeId;
    if (strokeId) {
      this.flushPendingStrokePoints();
      const mutation = this.withOp({ type: "stroke.end", stroke_id: strokeId });
      this.state.applyEvent(mutation, null, this.clientId);
      this.sendEvent(mutation);
      this.onStrokeFinished(strokeId);

      this.renderer.invalidateBase();
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
    const pressure = Number(event.pressure ?? event.force);
    return {
      x: point.x,
      y: point.y,
      pressure: Number.isFinite(pressure) && pressure > 0 ? Math.min(1, pressure) : 0.45,
    };
  }

  withOp(event) {
    return { ...event, op_id: createId() };
  }
}

export function isContactEvent(event) {
  const pressure = Number(event.pressure ?? event.force ?? 0);
  const buttons = Number(event.buttons ?? 0);
  return pressure > 0 || buttons !== 0;
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
