const popover = document.getElementById("morePopover");
const clearButton = document.getElementById("clearBoard");

if (popover && clearButton && !document.getElementById("exportPdf")) {
  const button = document.createElement("button");
  button.id = "exportPdf";
  button.className = "popover-action";
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.textContent = "Скачать всю доску как PDF";
  popover.insertBefore(button, clearButton);

  button.addEventListener("click", () => exportBoardPdf(button));
}

async function exportBoardPdf(button) {
  const boardId = resolveBoardId();
  if (!boardId || button.disabled) return;
  document.getElementById("morePopover")?.classList.add("hidden");
  document.getElementById("moreTrigger")?.setAttribute("aria-expanded", "false");

  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Готовлю PDF…";
  showToast("Готовлю всю доску в PDF…", "busy");
  try {
    const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/export.pdf`, {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        detail = payload?.detail || detail;
      } catch (_) {}
      throw new Error(String(detail));
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error("Сервер вернул пустой PDF");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Studybruh-${boardId}-${localDateStamp()}.pdf`;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
    showToast("PDF доски сохранён", "success");
  } catch (error) {
    console.error("Board PDF export failed:", error);
    showToast(`Не удалось сохранить PDF: ${String(error?.message || error).slice(0, 160)}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function resolveBoardId() {
  const match = location.pathname.match(/^\/b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/);
  return match?.[1] || "";
}

function localDateStamp() {
  const date = new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let toastTimer = null;
function showToast(message, tone = "") {
  const toast = document.getElementById("boardToast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = String(message || "");
  toast.className = `board-toast ${tone}`.trim();
  if (tone !== "busy") toastTimer = setTimeout(() => toast.classList.add("hidden"), 2400);
}
