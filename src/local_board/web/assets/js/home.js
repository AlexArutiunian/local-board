const createButton = document.getElementById("createRoom");
const createStatus = document.getElementById("createStatus");
const joinForm = document.getElementById("joinForm");
const roomInput = document.getElementById("roomInput");
const joinError = document.getElementById("joinError");

createButton.addEventListener("click", createRoom);
joinForm.addEventListener("submit", openRoom);
roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.replace(/\D/g, "").slice(0, 4);
  hideJoinError();
});

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
  const roomId = roomInput.value.trim();
  if (!/^\d{4}$/.test(roomId)) {
    showJoinError("Код комнаты — ровно 4 цифры.");
    return;
  }
  hideJoinError();
  location.assign(`/b/${roomId}`);
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.classList.remove("hidden");
}

function hideJoinError() {
  joinError.classList.add("hidden");
  joinError.textContent = "";
}
