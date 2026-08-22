import { bindPenUiControls } from "./pen-ui-controls.js";

const ROLES = new Set(["teacher", "student"]);

export async function resolveParticipantProfile() {
  bindPenUiControls(document);
  const params = new URLSearchParams(location.search);
  const roleHint = ROLES.has(params.get("role")) ? params.get("role") : null;
  const nameHint = cleanName(params.get("name"));
  const storedRole = loadString("local-board:participant-role");
  const initialRole = roleHint || (ROLES.has(storedRole) ? storedRole : null);

  if (roleHint && nameHint) {
    saveProfile(roleHint, nameHint);
    stripNameFromUrl();
    return buildProfile(roleHint, nameHint);
  }

  if (initialRole) {
    const storedName = cleanName(loadString(nameKey(initialRole)));
    if (storedName) return buildProfile(initialRole, storedName);
  }

  return showProfileDialog({ role: initialRole || "student", lockRole: Boolean(roleHint) });
}

export async function editParticipantProfile(currentProfile) {
  bindPenUiControls(document);
  await showProfileDialog({
    role: currentProfile?.role === "teacher" ? "teacher" : "student",
    name: currentProfile?.name || "",
    lockRole: false,
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

export function shareUrlForRole(boardId, role, teacherName = "") {
  const url = new URL(`/b/${encodeURIComponent(boardId)}`, location.origin);
  url.searchParams.set("role", role === "teacher" ? "teacher" : "student");
  if (role === "teacher" && cleanName(teacherName)) url.searchParams.set("name", cleanName(teacherName));
  return url.toString();
}

function buildProfile(role, name) {
  saveProfile(role, name);
  document.documentElement.dataset.participantRole = role;
  document.getElementById("copyTeacherLink")?.classList.toggle("hidden", role !== "teacher");
  return { role, name, device: deviceLabel() };
}

function saveProfile(role, name) {
  try {
    localStorage.setItem("local-board:participant-role", role);
    localStorage.setItem(nameKey(role), cleanName(name));
  } catch (_) {}
}

function nameKey(role) { return `local-board:participant-name:${role}`; }
function loadString(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
function cleanName(value) { return String(value || "").trim().slice(0, 48); }

function stripNameFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has("name")) return;
  url.searchParams.delete("name");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function showProfileDialog({ role, name = "", lockRole = false, title = "Кто вы в этой доске?" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "profile-dialog-backdrop";
    overlay.innerHTML = `
      <form class="profile-dialog" aria-label="Профиль участника">
        <div class="profile-dialog-kicker">Local Board</div>
        <h2>${escapeHtml(title)}</h2>
        <p>Имя и роль видят остальные участники комнаты.</p>
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
