const DEFAULT_IDLE_GRACE_MS = 1400;
const ACTIVE_WRITER_STALE_MS = 900;
const AUTO_FOLLOW_TIME_CONSTANT_MS = 420;
const GO_TO_LAST_TIME_CONSTANT_MS = 480;

/**
 * Role-neutral camera assistance for collaborative writing.
 *
 * - Remote active ink can softly pull a passive viewer toward the writing head.
 * - The writer's source zoom is used when the visual scale differs materially.
 * - Any local interaction temporarily wins over automatic following.
 * - The last written position is remembered for an explicit "go to last" action.
 */
export class RemoteFollowController {
  constructor({ renderer, localClientId, idleGraceMs = DEFAULT_IDLE_GRACE_MS }) {
    this.renderer = renderer;
    this.localClientId = localClientId;
    this.idleGraceMs = idleGraceMs;
    this.pausedUntil = 0;

    this.activeActorId = null;
    this.activeStrokeId = null;
    this.activeSourceZoom = null;
    this.activeSeenAt = 0;

    this.localStrokeId = null;
    this.localSourceZoom = null;

    this.lastWrittenPoint = null;
    this.lastWrittenZoom = null;
    this.lastWrittenStrokeId = null;
    this.lastWrittenActorId = null;
  }

  noteLocalInteraction(now = performance.now()) {
    this.pausedUntil = Math.max(this.pausedUntil, now + this.idleGraceMs);
    this.renderer.cancelFollowAnimation?.();
  }

  isPaused(now = performance.now()) {
    return now < this.pausedUntil;
  }

  observeLocal(event, now = performance.now()) {
    if (!event) return;

    if (event.type === "stroke.begin") {
      this.localStrokeId = event.stroke?.id || null;
      this.localSourceZoom = normalizeZoom(event.stroke?.source_zoom) ?? this.renderer.view.zoom;
      this.remember(
        lastPoint(event.stroke?.points),
        this.localSourceZoom,
        this.localStrokeId,
        this.localClientId,
      );
      return;
    }

    if (event.type === "stroke.append" && event.stroke_id === this.localStrokeId) {
      this.remember(
        lastPoint(event.points),
        this.localSourceZoom,
        event.stroke_id,
        this.localClientId,
      );
      return;
    }

    if (event.type === "stroke.end" && event.stroke_id === this.localStrokeId) {
      this.localStrokeId = null;
      this.localSourceZoom = null;
    } else if (event.type === "board.clear") {
      this.clearLast();
    }
  }

  observe(event, actorId, now = performance.now()) {
    if (!event || !actorId || actorId === this.localClientId) return false;

    if (event.type === "stroke.begin") {
      this.activeActorId = actorId;
      this.activeStrokeId = event.stroke?.id || null;
      this.activeSourceZoom = normalizeZoom(event.stroke?.source_zoom);
      this.activeSeenAt = now;
      const point = lastPoint(event.stroke?.points);
      this.remember(point, this.activeSourceZoom, this.activeStrokeId, actorId);
      return this.followPoint(point, this.activeSourceZoom, now);
    }

    if (event.type === "stroke.append") {
      const sameStroke = this.activeActorId === actorId
        && this.activeStrokeId === event.stroke_id;
      const previousWriterIsStale = now - this.activeSeenAt > ACTIVE_WRITER_STALE_MS;
      if (!sameStroke && !previousWriterIsStale) return false;

      if (!sameStroke) {
        this.activeSourceZoom = null;
      }
      this.activeActorId = actorId;
      this.activeStrokeId = event.stroke_id || null;
      this.activeSeenAt = now;
      const point = lastPoint(event.points);
      this.remember(point, this.activeSourceZoom, this.activeStrokeId, actorId);
      return this.followPoint(point, this.activeSourceZoom, now);
    }

    if (event.type === "stroke.end") {
      if (this.activeActorId === actorId && this.activeStrokeId === event.stroke_id) {
        this.activeSeenAt = now;
      }
      return false;
    }

    if (event.type === "stroke.delete" || event.type === "board.clear") {
      if (event.type === "board.clear") this.clearLast();
      if (event.type === "board.clear" || event.stroke_id === this.activeStrokeId) {
        this.activeActorId = null;
        this.activeStrokeId = null;
        this.activeSourceZoom = null;
      }
    }
    return false;
  }

  seedLastFromStrokes(strokes) {
    if (!Array.isArray(strokes)) return false;
    for (let index = strokes.length - 1; index >= 0; index -= 1) {
      const stroke = strokes[index];
      const point = lastPoint(stroke?.points);
      if (!point) continue;
      this.remember(
        point,
        normalizeZoom(stroke.source_zoom),
        stroke.id || null,
        stroke.author_id || null,
      );
      return true;
    }
    return false;
  }

  hasLastWritten() {
    return Boolean(this.lastWrittenPoint);
  }

  goToLastWritten() {
    if (!this.lastWrittenPoint) return false;
    this.pausedUntil = 0;
    const { width, height } = this.renderer.getViewportSize();
    const zoom = this.lastWrittenZoom ?? this.renderer.view.zoom;
    return this.renderer.smoothFocusWorldPoint(this.lastWrittenPoint, {
      zoom,
      screenX: width * 0.52,
      screenY: height * 0.46,
      timeConstant: GO_TO_LAST_TIME_CONSTANT_MS,
    });
  }

  followPoint(point, sourceZoom, now = performance.now()) {
    if (!point || this.isPaused(now)) return false;

    const screenPoint = this.renderer.worldToScreen(point);
    const { width, height } = this.renderer.getViewportSize();
    const delta = computeFollowDelta({ point: screenPoint, width, height });
    const targetZoom = matchedSourceZoom(this.renderer.view.zoom, sourceZoom);
    const scaleNeeded = Math.abs(Math.log(targetZoom / this.renderer.view.zoom)) > 0.04;
    if (!delta.needed && !scaleNeeded) return false;

    // When only scale changes, keep the writing head visually where it already is.
    // When it approaches an edge, move it only far enough to create writing room.
    const desiredX = screenPoint.x + delta.dx;
    const desiredY = screenPoint.y + delta.dy;
    return this.renderer.smoothFocusWorldPoint(point, {
      zoom: targetZoom,
      screenX: desiredX,
      screenY: desiredY,
      timeConstant: AUTO_FOLLOW_TIME_CONSTANT_MS,
    });
  }

  remember(point, zoom, strokeId, actorId) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.lastWrittenPoint = { x: Number(point.x), y: Number(point.y) };
    this.lastWrittenZoom = normalizeZoom(zoom);
    this.lastWrittenStrokeId = strokeId || null;
    this.lastWrittenActorId = actorId || null;
  }

  clearLast() {
    this.lastWrittenPoint = null;
    this.lastWrittenZoom = null;
    this.lastWrittenStrokeId = null;
    this.lastWrittenActorId = null;
  }
}

export function computeFollowDelta({ point, width, height }) {
  if (!point || width <= 0 || height <= 0) return { dx: 0, dy: 0, needed: false };

  // Start moving before the writing head hits the literal viewport edge, but do
  // not recenter it aggressively. The lower guard accounts for the toolbar.
  const leftGuard = clamp(width * 0.14, 64, 150);
  const rightGuard = clamp(width * 0.14, 64, 150);
  const topGuard = clamp(height * 0.12, 56, 120);
  const bottomGuard = clamp(height * 0.20, 96, 180);

  const safeLeft = leftGuard;
  const safeRight = width - rightGuard;
  const safeTop = topGuard;
  const safeBottom = height - bottomGuard;

  let dx = 0;
  let dy = 0;

  if (point.x < safeLeft) {
    dx = width * 0.22 - point.x;
  } else if (point.x > safeRight) {
    dx = width * 0.78 - point.x;
  }

  if (point.y < safeTop) {
    dy = height * 0.24 - point.y;
  } else if (point.y > safeBottom) {
    dy = height * 0.72 - point.y;
  }

  return { dx, dy, needed: Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 };
}

export function matchedSourceZoom(currentZoom, sourceZoom) {
  const current = clamp(Number(currentZoom) || 1, 0.2, 5);
  const source = normalizeZoom(sourceZoom);
  if (source === null) return current;

  // Avoid tiny distracting zoom corrections. If the writing is materially
  // different in apparent size, match the source exactly and do it smoothly.
  const ratio = source / current;
  if (ratio > 0.88 && ratio < 1.14) return current;
  return source;
}

function normalizeZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, 0.2, 5);
}

function lastPoint(points) {
  return Array.isArray(points) && points.length ? points[points.length - 1] : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
