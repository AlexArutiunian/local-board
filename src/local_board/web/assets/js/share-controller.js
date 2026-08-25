export class SecureShareController {
  constructor({ boardId, participantRole, showToast = null }) {
    this.boardId = boardId;
    this.participantRole = participantRole;
    this.showToast = showToast;
    this.bound = false;
    this.lastInviteUrl = "";
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.trigger = document.getElementById("shareRoom");
    this.popover = document.getElementById("sharePopover");
    this.studentButton = document.getElementById("copyStudentLink");
    this.teacherButton = document.getElementById("copyTeacherLink");
    this.rotateButton = document.getElementById("rotatePasscode");
    this.passcodeNode = document.getElementById("roomPasscode");
    this.qrPanel = document.getElementById("shareQrPanel");
    this.qrImage = document.getElementById("shareQrImage");
    this.qrTitle = document.getElementById("shareQrTitle");
    this.qrExpires = document.getElementById("shareQrExpires");
    this.qrUrl = document.getElementById("shareQrUrl");
    this.copyQrLink = document.getElementById("copyQrLink");

    if (!this.trigger || !this.popover) return;
    const isTeacher = this.participantRole === "teacher";
    this.trigger.classList.toggle("hidden", !isTeacher);
    if (!isTeacher) return;

    this.renderPasscode();
    this.trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = this.popover.classList.contains("hidden");
      this.popover.classList.toggle("hidden", !opening);
      this.trigger.setAttribute("aria-expanded", String(opening));
      if (opening) this.renderPasscode();
    });
    this.studentButton?.addEventListener("click", () => this.createInvite("student"));
    this.teacherButton?.addEventListener("click", () => this.createInvite("teacher"));
    this.rotateButton?.addEventListener("click", () => this.rotatePasscode());
    this.copyQrLink?.addEventListener("click", async () => {
      if (!this.lastInviteUrl) return;
      const copied = await copyText(this.lastInviteUrl);
      this.showToast?.(copied ? "Ссылка скопирована" : "Не удалось скопировать", copied ? "success" : "error");
    });

    document.addEventListener("pointerdown", (event) => {
      if (this.popover.classList.contains("hidden")) return;
      if (this.popover.contains(event.target) || this.trigger.contains(event.target)) return;
      this.close();
    }, { capture: true });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  close() {
    this.popover?.classList.add("hidden");
    this.trigger?.setAttribute("aria-expanded", "false");
  }

  renderPasscode() {
    if (!this.passcodeNode) return;
    const passcode = loadRoomPasscode(this.boardId);
    this.passcodeNode.textContent = passcode || "Не сохранён на этом устройстве";
    this.passcodeNode.classList.toggle("muted", !passcode);
  }

  async createInvite(role) {
    const button = role === "teacher" ? this.teacherButton : this.studentButton;
    if (button) button.disabled = true;
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(this.boardId)}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (response.status === 401 || response.status === 403) {
        this.showToast?.("Нужен доступ преподавателя", "error");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const invite = await response.json();
      this.lastInviteUrl = String(invite.url || "");
      this.renderQr(invite);
      const copied = await copyText(this.lastInviteUrl);
      const label = role === "teacher" ? "Ссылка преподавателя" : "Ссылка ученику";
      this.showToast?.(copied ? `${label} скопирована` : `${label} создана`, copied ? "success" : "");
    } catch (error) {
      console.error("Invite creation failed:", error);
      this.showToast?.("Не удалось создать приглашение", "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  renderQr(invite) {
    if (!this.qrPanel) return;
    const teacherInvite = invite.role === "teacher";
    this.qrPanel.classList.remove("hidden");
    if (this.qrImage) {
      this.qrImage.src = String(invite.qr_data_url || "");
      this.qrImage.alt = teacherInvite ? "QR для преподавателя" : "QR для ученика";
    }
    if (this.qrTitle) this.qrTitle.textContent = teacherInvite ? "Второе устройство преподавателя" : "Вход ученика";
    if (this.qrExpires) this.qrExpires.textContent = `Действует до ${formatExpiry(invite.expires_at_ms)}`;
    if (this.qrUrl) this.qrUrl.textContent = this.lastInviteUrl;
  }

  async rotatePasscode() {
    if (!this.rotateButton) return;
    const confirmed = confirm("Сменить пароль комнаты? Старый пароль сразу перестанет подходить для нового входа.");
    if (!confirmed) return;
    this.rotateButton.disabled = true;
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(this.boardId)}/passcode/rotate`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const passcode = String(payload.passcode || "");
      if (!/^\d{6}$/.test(passcode)) throw new Error("invalid passcode response");
      saveRoomPasscode(this.boardId, passcode);
      this.renderPasscode();
      this.showToast?.("Пароль комнаты изменён", "success");
    } catch (error) {
      console.error("Passcode rotation failed:", error);
      this.showToast?.("Не удалось сменить пароль", "error");
    } finally {
      this.rotateButton.disabled = false;
    }
  }
}

function passcodeKey(boardId) { return `local-board:room-passcode:${boardId}`; }
function loadRoomPasscode(boardId) {
  try { return localStorage.getItem(passcodeKey(boardId)) || ""; } catch (_) { return ""; }
}
function saveRoomPasscode(boardId, value) {
  try { localStorage.setItem(passcodeKey(boardId), value); } catch (_) {}
}

function formatExpiry(value) {
  const date = new Date(Number(value || 0));
  if (!Number.isFinite(date.getTime())) return "неизвестно";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
  textarea.remove();
  return copied;
}
