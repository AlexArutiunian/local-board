const createButtons = [
  document.getElementById("createRoom"),
  document.getElementById("createRoomEmpty"),
].filter(Boolean);
const createStatus = document.getElementById("createStatus");
const joinForm = document.getElementById("joinForm");
const roomInput = document.getElementById("roomInput");
const passcodeInput = document.getElementById("passcodeInput");
const joinError = document.getElementById("joinError");
const boardsGrid = document.getElementById("boardsGrid");
const emptyBoards = document.getElementById("emptyBoards");
const teacherLoginForm = document.getElementById("teacherLoginForm");
const teacherPassword = document.getElementById("teacherPassword");
const teacherLoginHint = document.getElementById("teacherLoginHint");
const teacherLoginError = document.getElementById("teacherLoginError");
const teacherState = document.getElementById("teacherState");
const teacherLogout = document.getElementById("teacherLogout");
let teacherAuthenticated = false;

for (const button of createButtons) button.addEventListener("click", createRoom);
joinForm.addEventListener("submit", openRoom);
teacherLoginForm.addEventListener("submit", loginTeacher);
teacherLogout.addEventListener("click", logoutTeacher);
roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.replace(/\D/g, "").slice(0, 4);
  hideJoinError();
});
passcodeInput.addEventListener("input", () => {
  passcodeInput.value = passcodeInput.value.replace(/\D/g, "").slice(0, 6);
  hideJoinError();
});
teacherPassword.addEventListener("input", hideTeacherError);

prefillJoin();
await refreshTeacherSession();
await loadRooms();

async function refreshTeacherSession() {
  try {
    const response = await fetch("/api/admin/session", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    teacherAuthenticated = Boolean(payload.authenticated);
    renderTeacherState(Boolean(payload.required));
  } catch (error) {
    console.error("Teacher session failed:", error);
    teacherAuthenticated = false;
    renderTeacherState(true);
  }
}

function renderTeacherState(required) {
  const unlocked = teacherAuthenticated || !required;
  createButtons.forEach((button) => { button.disabled = !unlocked; });
  teacherLoginForm.classList.toggle("authenticated", unlocked);
  teacherPassword.disabled = unlocked;
  teacherLoginForm.querySelector('button[type="submit"]').classList.toggle("hidden", unlocked);
  teacherLogout.classList.toggle("hidden", !teacherAuthenticated || !required);
  teacherState.textContent = unlocked ? "Преподаватель" : "Гость";
  teacherState.classList.toggle("active", unlocked);
  teacherLoginHint.textContent = unlocked
    ? "Управление досками открыто на этом устройстве."
    : "Нужен только для создания и управления досками.";
  if (unlocked) hideTeacherError();
}

async function loginTeacher(event) {
  event.preventDefault();
  hideTeacherError();
  const password = teacherPassword.value;
  if (password.length < 1) {
    showTeacherError("Введите пароль преподавателя.");
    return;
  }
  const submit = teacherLoginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.status === 401) {
      showTeacherError("Неверный пароль преподавателя.");
      return;
    }
    if (response.status === 429) {
      showTeacherError("Слишком много попыток. Подожди несколько минут.");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    teacherPassword.value = "";
    await refreshTeacherSession();
    await loadRooms();
  } catch (error) {
    console.error("Teacher login failed:", error);
    showTeacherError("Не удалось открыть режим преподавателя.");
  } finally {
    submit.disabled = false;
  }
}

async function logoutTeacher() {
  teacherLogout.disabled = true;
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } finally {
    teacherLogout.disabled = false;
    await refreshTeacherSession();
    await loadRooms();
  }
}

async function loadRooms() {
  try {
    const response = await fetch("/api/rooms", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    renderRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
  } catch (error) {
    console.error("Room list failed:", error);
    boardsGrid.innerHTML = "";
    emptyBoards.classList.remove("hidden");
    emptyBoards.querySelector("h3").textContent = "Не удалось загрузить доски";
    emptyBoards.querySelector("p").textContent = "Проверь сервер и обнови страницу.";
  }
}

function renderRooms(rooms) {
  boardsGrid.innerHTML = "";
  emptyBoards.classList.toggle("hidden", rooms.length !== 0);
  boardsGrid.classList.toggle("hidden", rooms.length === 0);

  for (const room of rooms) {
    const card = document.createElement("a");
    card.className = "board-card";
    card.href = room.path;

    const contentCount = Number(room.stroke_count || 0) + Number(room.object_count || 0);
    const contentLabel = contentCount === 1 ? "1 объект" : `${contentCount} объектов`;
    card.innerHTML = `
      <div class="board-card-top">
        <div>
          <div class="room-code">${escapeHtml(room.room_id)}</div>
          <div class="board-meta">${escapeHtml(contentLabel)}</div>
        </div>
        <div class="board-icon" aria-hidden="true">⌁</div>
      </div>
      <div class="board-footer">
        <span>${escapeHtml(formatUpdatedAt(room.updated_at))}</span>
        <span class="open-arrow" aria-hidden="true">→</span>
      </div>
    `;
    boardsGrid.appendChild(card);
  }
}

async function createRoom() {
  if (!teacherAuthenticated) {
    teacherPassword.focus();
    showTeacherError("Сначала открой режим преподавателя.");
    return;
  }
  for (const button of createButtons) button.disabled = true;
  createStatus.textContent = "Создаю защищённую доску…";
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    if (response.status === 401) {
      teacherAuthenticated = false;
      await refreshTeacherSession();
      showTeacherError("Сессия преподавателя закончилась. Войди снова.");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const room = await response.json();
    try {
      localStorage.setItem(`local-board:room-passcode:${room.room_id}`, room.passcode || "");
    } catch (_) {}
    location.assign(room.path);
  } catch (error) {
    console.error("Room creation failed:", error);
    createStatus.textContent = "Не удалось создать доску";
    createButtons.forEach((button) => { button.disabled = !teacherAuthenticated; });
  }
}

async function openRoom(event) {
  event.preventDefault();
  const roomId = roomInput.value.trim();
  const passcode = passcodeInput.value.trim();
  if (!/^\d{4}$/.test(roomId)) {
    showJoinError("Код комнаты — ровно 4 цифры.");
    return;
  }
  if (!/^\d{6}$/.test(passcode)) {
    showJoinError("Пароль комнаты — 6 цифр.");
    return;
  }

  hideJoinError();
  const submit = joinForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch(`/api/boards/${roomId}/auth/passcode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (response.status === 404) {
      showJoinError("Такой комнаты нет.");
      return;
    }
    if (response.status === 401) {
      showJoinError("Неверный код комнаты или пароль.");
      return;
    }
    if (response.status === 429) {
      showJoinError("Слишком много попыток. Подожди несколько минут.");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    location.assign(payload.path || `/b/${roomId}`);
  } catch (error) {
    console.error("Room login failed:", error);
    showJoinError("Не удалось войти в комнату.");
  } finally {
    submit.disabled = false;
  }
}

function prefillJoin() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room") || "";
  if (/^\d{4}$/.test(room)) roomInput.value = room;
  if (params.get("auth") === "invalid") showJoinError("Ссылка-приглашение недействительна или устарела.");
  if (roomInput.value) requestAnimationFrame(() => passcodeInput.focus());
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Недавно";
  const now = new Date();
  const sameDay = now.toDateString() === date.toDateString();
  if (sameDay) {
    return `Сегодня, ${new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)}`;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.classList.remove("hidden");
}

function hideJoinError() {
  joinError.classList.add("hidden");
  joinError.textContent = "";
}

function showTeacherError(message) {
  teacherLoginError.textContent = message;
  teacherLoginError.classList.remove("hidden");
}

function hideTeacherError() {
  teacherLoginError.classList.add("hidden");
  teacherLoginError.textContent = "";
}
