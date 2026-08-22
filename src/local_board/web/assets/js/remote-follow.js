const DEFAULT_IDLE_GRACE_MS = 1400;
const ACTIVE_WRITER_STALE_MS = 900;

/**
 * Keeps a passive viewer near the head of the currently active remote stroke.
 *
 * This is intentionally role-neutral: any participant can write and any other
 * participant can follow. Viewports are never synchronized over the network;
 * only already-received stroke coordinates are used to adjust this browser's
 * local camera.
 */
export class RemoteFollowController {
  constructor({ renderer, localClientId, idleGraceMs = DEFAULT_IDLE_GRACE_MS }) {
    this.renderer = renderer;
    this.localClientId = localClientId;
    this.idleGraceMs = idleGraceMs;
    this.pausedUntil = 0;
    this.activeActorId = null;
    this.activeStrokeId = null;
    this.activeSeenAt = 0;
  }

  noteLocalInteraction(now = performance.now()) {
    this.pausedUntil = Math.max(this.pausedUntil, now + this.idleGraceMs);
    this.renderer.cancelFollowAnimation?.();
  }

  isPaused(now = performance.now()) {
    return now < this.pausedUntil;
  }

  observe(event, actorId, now = performance.now()) {
    if (!event || !actorId || actorId === this.localClientId) return false;

    if (event.type === "stroke.begin") {
      this.activeActorId = actorId;
      this.activeStrokeId = event.stroke?.id || null;
      this.activeSeenAt = now;
      return this.followPoint(lastPoint(event.stroke?.points), now);
    }

    if (event.type === "stroke.append") {
      const sameStroke = this.activeActorId === actorId
        && this.activeStrokeId === event.stroke_id;
      const previousWriterIsStale = now - this.activeSeenAt > ACTIVE_WRITER_STALE_MS;

      // Do not jump between two people who happen to be writing at once. A new
      // explicit stroke.begin always takes focus; append can take over only when
      // the previous writer has gone quiet.
      if (!sameStroke && !previousWriterIsStale) return false;

      this.activeActorId = actorId;
      this.activeStrokeId = event.stroke_id || null;
      this.activeSeenAt = now;
      return this.followPoint(lastPoint(event.points), now);
    }

    if (event.type === "stroke.end") {
      if (this.activeActorId === actorId && this.activeStrokeId === event.stroke_id) {
        this.activeSeenAt = now;
      }
      return false;
    }

    if (event.type === "stroke.delete" || event.type === "board.clear") {
      if (event.type === "board.clear" || event.stroke_id === this.activeStrokeId) {
        this.activeActorId = null;
        this.activeStrokeId = null;
      }
    }
    return false;
  }

  followPoint(point, now = performance.now()) {
    if (!point || this.isPaused(now)) return false;
    return this.renderer.followWorldPoint(point);
  }
}

export function computeFollowDelta({ point, width, height }) {
  if (!point || width <= 0 || height <= 0) return { dx: 0, dy: 0, needed: false };

  // Keep a generous reading area around the writer. The bottom margin is larger
  // because the floating toolbar occupies part of the visible canvas.
  const leftGuard = clamp(width * 0.18, 72, 180);
  const rightGuard = clamp(width * 0.18, 72, 180);
  const topGuard = clamp(height * 0.16, 64, 150);
  const bottomGuard = clamp(height * 0.24, 110, 210);

  const safeLeft = leftGuard;
  const safeRight = width - rightGuard;
  const safeTop = topGuard;
  const safeBottom = height - bottomGuard;

  let dx = 0;
  let dy = 0;

  if (point.x < safeLeft) {
    dx = width * 0.34 - point.x;
  } else if (point.x > safeRight) {
    dx = width * 0.66 - point.x;
  }

  if (point.y < safeTop) {
    dy = height * 0.32 - point.y;
  } else if (point.y > safeBottom) {
    dy = height * 0.64 - point.y;
  }

  return { dx, dy, needed: Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 };
}

function lastPoint(points) {
  return Array.isArray(points) && points.length ? points[points.length - 1] : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
