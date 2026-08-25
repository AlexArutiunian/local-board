import { bindPenUiControls } from "./pen-ui-controls.js";

const ROLES = new Set(["teacher", "student"]);

export async function resolveParticipantProfile() {
  bindPenUiControls(document);
  const serverRole = await loadSessionRole();
  const role = ROLES.has(serverRole) ? serverRole : "student";
  const storedName = cleanName(loadString(nameKey(role)));
  if (storedName) return buildProfile(role, storedName);
  return showProfileDialog({ role, lockRole: true });
}

export async function editParticipantProfile(currentProfile) {
  bindPenUiControls(document);
  await showProfileDialog({
    role: currentProfile?.role === "teacher" ? "teacher" : "student",
    name: currentProfile?.name || "",
    lockRole: true,
    title: "Ваш профиль в комнате",
  });
  window.history.replaceState(null, "", location.pathname);
  location.reload();
  return new Promise(() => {});
}

export function roleLabel(role) {
  return role === "teacher" ? "Преподаватель" : "Ученик";
}

export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const touchPoints = Number(navigator.maxTouchPoints || 0);
  if (/iPad/i.test(ua) || (platform === "MacIntel" && touchPoints > 1)) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return "Телефон";
  if (/Android/i.test(ua)) return "Планшет";
  return "Компьютер";
}

async function loadSessionRole() {
  const boardId = resolveBoardId();
  try {
    const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/session`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      location.assign(`/?room=${encodeURIComponent(boardId)}`);
      return null;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload.role;
  } catch (error) {
    console.warn("Failed to resolve room session role:", error);
    return null;
  }
}

function buildProfile(role, name) {
  saveProfile(role, name);
  document.documentElement.dataset.participantRole = role;
  document.getElementById("copyTeacherLink")?.classList.toggle("hidden", role !== "teacher");
  document.getElementById("rotatePasscode")?.classList.toggle("hidden", role !== "teacher");
  return { role, name, device: deviceLabel() };
}

function saveProfile(role, name) {
  try {
    localStorage.setItem(nameKey(role), cleanName(name));
  } catch (_) {}
}

function nameKey(role) { return `local-board:participant-name:${role}`; }
function loadString(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
function cleanName(value) { return String(value || "").trim().slice(0, 48); }

function showProfileDialog({ role, name = "", lockRole = false, title = "Кто вы в этой доске?" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "profile-dialog-backdrop";
    overlay.innerHTML = `
      <form class="profile-dialog" aria-label="Профиль участника">
        <div class="profile-dialog-kicker">Local Board</div>
        <h2>${escapeHtml(title)}</h2>
        <p>Имя видят остальные участники. Роль выдана защищённой сессией комнаты.</p>
        <div class="profile-role-switch" role="group" aria-label="Роль">
          <button type="button" data-role="teacher">Преподаватель</button>
          <button type="button" data-role="student">Ученик</button>
        </div>
        <label class="profile-name-field">
          <span>Имя</span>
          <input type="text" maxlength="48" autocomplete="name" placeholder="Например, Александр" required />
        </label>
        <button class="profile-continue" type="submit">Продолжить</button>
      </form>
    `;
    document.body.appendChild(overlay);
    const form = overlay.querySelector("form");
    const input = overlay.querySelector("input");
    const roleButtons = [...overlay.querySelectorAll("[data-role]")];
    let selectedRole = ROLES.has(role) ? role : "student";

    input.value = cleanName(name) || cleanName(loadString(nameKey(selectedRole)));
    updateRoleButtons();
    if (lockRole) roleButtons.forEach((button) => { button.disabled = button.dataset.role !== selectedRole; });

    roleButtons.forEach((button) => button.addEventListener("click", () => {
      if (lockRole) return;
      selectedRole = button.dataset.role;
      const remembered = cleanName(loadString(nameKey(selectedRole)));
      if (remembered) input.value = remembered;
      updateRoleButtons();
      input.focus();
    }));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const clean = cleanName(input.value);
      if (!clean) {
        input.focus();
        return;
      }
      const profile = buildProfile(selectedRole, clean);
      overlay.remove();
      resolve(profile);
    });

    requestAnimationFrame(() => input.focus());

    function updateRoleButtons() {
      roleButtons.forEach((button) => {
        const active = button.dataset.role === selectedRole;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    }
  });
}

function resolveBoardId() {
  const match = location.pathname.match(/^\/b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/);
  return match ? match[1] : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
