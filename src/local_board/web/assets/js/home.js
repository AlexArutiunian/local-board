const createButton = document.getElementById("createRoom");
const createStatus = document.getElementById("createStatus");
const joinForm = document.getElementById("joinForm");
const roomInput = document.getElementById("roomInput");
const joinError = document.getElementById("joinError");

createButton.addEventListener("click", createRoom);
joinForm.addEventListener("submit", openRoom);

async function createRoom() {
  createButton.disabled = true;
  createStatus.textContent = "Создаю комнату…";
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const room = await response.json();
    location.assign(room.path);
  } catch (error) {
    console.error("Room creation failed:", error);
    createStatus.textContent = "Не удалось создать комнату";
    createButton.disabled = false;
  }
}

function openRoom(event) {
  event.preventDefault();
  const roomId = parseRoomId(roomInput.value);
  if (!roomId) {
    showJoinError("Введи корректный код комнаты или ссылку.");
    return;
  }
  hideJoinError();
  location.assign(`/b/${encodeURIComponent(roomId)}`);
}

function parseRoomId(rawValue) {
  const value = rawValue.trim();
  if (!value) return null;

  let candidate = value;
  try {
    if (/^https?:\/\//i.test(value)) {
      candidate = new URL(value).pathname;
    }
  } catch (_) {
    return null;
  }

  const pathMatch = candidate.match(/^\/?b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/);
  if (pathMatch) return pathMatch[1];
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidate)) return candidate;
  return null;
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.classList.remove("hidden");
}

function hideJoinError() {
  joinError.classList.add("hidden");
  joinError.textContent = "";
}
