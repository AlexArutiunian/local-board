export class RealtimeClient {
  constructor({ boardId, clientId, profile, onSnapshot, onEvent, onPresence, onStatus, onError }) {
    this.boardId = boardId;
    this.clientId = clientId;
    this.profile = profile;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;
    this.onPresence = onPresence;
    this.onStatus = onStatus;
    this.onError = onError;
    this.socket = null;
    this.pending = new Map();
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.closedByUser = false;
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.onStatus("connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({
      client_id: this.clientId,
      name: this.profile?.name || "Участник",
      role: this.profile?.role || "student",
      device: this.profile?.device || "Браузер",
    });
    const url = `${scheme}://${location.host}/ws/${encodeURIComponent(this.boardId)}?${params}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retryAttempt = 0;
      this.onStatus("online");
    });

    socket.addEventListener("message", (message) => {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch (_) {
        return;
      }

      if (payload.type === "snapshot") {
        this.onSnapshot(payload.board, this.pendingEvents());
        this.onPresence(payload.participants || 1, payload.roster || []);
        this.flushPending();
      } else if (payload.type === "event") {
        this.onEvent(payload.event, payload.revision, payload.actor_id);
      } else if (payload.type === "ack") {
        this.pending.delete(payload.op_id);
      } else if (payload.type === "presence") {
        this.onPresence(payload.participants || 0, payload.roster || []);
      } else if (payload.type === "error") {
        this.onError(payload.message || "Ошибка синхронизации");
      }
    });

    socket.addEventListener("close", () => {
      this.onStatus("offline");
      if (!this.closedByUser) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.onStatus("offline");
    });
  }

  send(event) {
    if (event.type !== "ping") this.pending.set(event.op_id, event);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  pendingEvents() {
    return [...this.pending.values()].map((event) => cloneJson(event));
  }

  flushPending() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const event of this.pending.values()) this.socket.send(JSON.stringify(event));
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(5000, 350 * 2 ** this.retryAttempt);
    this.retryAttempt = Math.min(this.retryAttempt + 1, 5);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
