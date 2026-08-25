
const MAX_CAPTURE_CHARS = 1000;

export function clipCapturedText(value, limit = MAX_CAPTURE_CHARS) {
  return String(value ?? "").slice(0, limit);
}

export function createTelemetryEvent(type, details = {}) {
  const text = details.text == null ? null : clipCapturedText(details.text);
  return {
    id: details.id || makeEventId(),
    type,
    question_id: details.questionId || null,
    client_time: details.clientTime ?? Date.now(),
    text,
    text_length: details.textLength ?? String(details.text ?? "").length,
    meta: details.meta || {},
  };
}

export function selectedTextFromTarget(target) {
  if (
    target &&
    typeof target.value === "string" &&
    Number.isInteger(target.selectionStart) &&
    Number.isInteger(target.selectionEnd)
  ) {
    return target.value.slice(target.selectionStart, target.selectionEnd);
  }
  return String(globalThis.getSelection?.() || "");
}

export class AssessmentTelemetry {
  constructor({ getSessionId, getQuestionId, endpointBase = "/api/assessment/sessions" }) {
    this.getSessionId = getSessionId;
    this.getQuestionId = getQuestionId;
    this.endpointBase = endpointBase;
    this.queue = [];
    this.flushTimer = null;
    this.started = false;
    this.listeners = [];
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.listen(document, "visibilitychange", () => {
      this.record(document.hidden ? "tab_hidden" : "tab_visible");
    });
    this.listen(window, "blur", () => this.record("window_blur"));
    this.listen(window, "focus", () => this.record("window_focus"));
    this.listen(document, "copy", (event) => {
      const text = selectedTextFromTarget(event.target);
      this.record("copy", { text, textLength: text.length });
    });
    this.listen(document, "cut", (event) => {
      const text = selectedTextFromTarget(event.target);
      this.record("cut", { text, textLength: text.length });
    });
    this.listen(document, "paste", (event) => {
      const text = event.clipboardData?.getData("text/plain") || "";
      this.record("paste", { text, textLength: text.length });
    });
    this.listen(document, "contextmenu", () => this.record("context_menu"));
    this.listen(document, "keydown", (event) => {
      if (event.key === "PrintScreen") this.record("print_screen_key");
    });
    this.listen(document, "fullscreenchange", () => {
      this.record(document.fullscreenElement ? "fullscreen_enter" : "fullscreen_exit");
    });
    this.listen(window, "pagehide", () => {
      void this.flush({ keepalive: true });
    });
    this.flushTimer = window.setInterval(() => {
      void this.flush();
    }, 5000);
  }

  stop() {
    for (const [target, type, handler] of this.listeners) {
      target.removeEventListener(type, handler);
    }
    this.listeners = [];
    if (this.flushTimer) window.clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.started = false;
  }

  listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.listeners.push([target, type, handler]);
  }

  record(type, details = {}) {
    if (!this.getSessionId()) return;
    this.queue.push(
      createTelemetryEvent(type, {
        ...details,
        questionId: details.questionId || this.getQuestionId(),
      }),
    );
    if (this.queue.length >= 20) void this.flush();
  }

  async flush({ keepalive = false } = {}) {
    const sessionId = this.getSessionId();
    if (!sessionId || this.queue.length === 0) return;
    const batch = this.queue.splice(0, 100);
    try {
      const response = await fetch(
        `${this.endpointBase}/${encodeURIComponent(sessionId)}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: batch }),
          keepalive,
        },
      );
      if (!response.ok) throw new Error(`telemetry failed: ${response.status}`);
    } catch (error) {
      this.queue.unshift(...batch);
      if (!keepalive) console.warn(error);
    }
  }
}

function makeEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

