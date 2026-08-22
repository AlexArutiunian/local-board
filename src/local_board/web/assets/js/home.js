const createButtons = [
  document.getElementById("createRoom"),
  document.getElementById("createRoomEmpty"),
].filter(Boolean);
const createStatus = document.getElementById("createStatus");
const joinForm = document.getElementById("joinForm");
const roomInput = document.getElementById("roomInput");
const joinError = document.getElementById("joinError");
const boardsGrid = document.getElementById("boardsGrid");
const emptyBoards = document.getElementById("emptyBoards");

for (const button of createButtons) button.addEventListener("click", createRoom);
joinForm.addEventListener("submit", openRoom);
roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.replace(/\D/g, "").slice(0, 4);
  hideJoinError();
});

loadRooms();

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
    card.href = `${room.path}?role=teacher`;

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
  for (const button of createButtons) button.disabled = true;
  createStatus.textContent = "Создаю доску…";
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const room = await response.json();
    location.assign(`${room.path}?role=teacher`);
  } catch (error) {
    console.error("Room creation failed:", error);
    createStatus.textContent = "Не удалось создать доску";
    for (const button of createButtons) button.disabled = false;
  }
}

async function openRoom(event) {
  event.preventDefault();
  const roomId = roomInput.value.trim();
  if (!/^\d{4}$/.test(roomId)) {
    showJoinError("Код комнаты — ровно 4 цифры.");
    return;
  }

  hideJoinError();
  const submit = joinForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch(`/api/boards/${roomId}`, { cache: "no-store" });
    if (response.status === 404) {
      showJoinError("Такой доски нет.");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    location.assign(`/b/${roomId}?role=teacher`);
  } catch (error) {
    console.error("Room lookup failed:", error);
    showJoinError("Не удалось проверить комнату.");
  } finally {
    submit.disabled = false;
  }
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
