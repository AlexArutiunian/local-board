import { createId } from "./id.js";
import { objectKey } from "./selection-controller.js";

const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class AssetController {
  constructor({ boardId, stage, fileInput, imageButton, state, renderer, sendEvent, selection, onInserted, onStatus }) {
    this.boardId = boardId;
    this.stage = stage;
    this.fileInput = fileInput;
    this.imageButton = imageButton;
    this.state = state;
    this.renderer = renderer;
    this.sendEvent = sendEvent;
    this.selection = selection;
    this.onInserted = onInserted;
    this.onStatus = onStatus;
    this.bind();
  }

  bind() {
    this.imageButton?.addEventListener("click", () => this.fileInput?.click());
    this.fileInput?.addEventListener("change", async () => {
      const files = [...(this.fileInput.files || [])];
      this.fileInput.value = "";
      for (const file of files) await this.insertFile(file, null);
    });

    this.stage.addEventListener("dragover", (event) => {
      if (![...(event.dataTransfer?.items || [])].some((item) => item.kind === "file" && item.type.startsWith("image/"))) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.stage.classList.add("asset-dragover");
    });
    this.stage.addEventListener("dragleave", () => this.stage.classList.remove("asset-dragover"));
    this.stage.addEventListener("drop", async (event) => {
      this.stage.classList.remove("asset-dragover");
      const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      for (const file of files) await this.insertFile(file, { clientX: event.clientX, clientY: event.clientY });
    });

    document.addEventListener("paste", async (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      for (const file of files) await this.insertFile(file, null);
    });
  }

  async insertFile(file, screenPoint) {
    if (!SUPPORTED_TYPES.has(file.type)) {
      this.onStatus?.("Поддерживаются PNG, JPEG, WEBP и GIF", "error");
      return false;
    }
    this.onStatus?.("Загружаю изображение…", "busy");
    try {
      const [upload, dimensions] = await Promise.all([
        this.upload(file),
        readImageDimensions(file),
      ]);
      const placement = this.computePlacement(dimensions, screenPoint);
      const object = {
        id: createId(),
        kind: "image",
        ...placement,
        src: upload.src,
        name: file.name || "image",
      };
      const event = { type: "object.create", op_id: createId(), object };
      this.state.applyEvent(event, null, "local");
      this.sendEvent(event);
      const key = objectKey(object.id);
      this.selection.selectOnly(key);
      this.renderer.invalidateBase();
      this.renderer.requestRender();
      this.onInserted?.(key);
      this.onStatus?.("Изображение добавлено", "success");
      return true;
    } catch (error) {
      console.error("Image insert failed:", error);
      this.onStatus?.("Не удалось добавить изображение", "error");
      return false;
    }
  }

  async upload(file) {
    const response = await fetch(`/api/boards/${encodeURIComponent(this.boardId)}/assets`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!response.ok) throw new Error(`asset upload HTTP ${response.status}`);
    return response.json();
  }

  computePlacement(dimensions, screenPoint) {
    const rect = this.renderer.canvas.getBoundingClientRect();
    const targetClient = screenPoint || {
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.48,
    };
    const center = this.renderer.screenToWorld(targetClient.clientX, targetClient.clientY);
    const maxScreenWidth = Math.min(520, rect.width * 0.62);
    const maxScreenHeight = Math.min(420, rect.height * 0.58);
    const naturalWidth = Math.max(1, dimensions.width);
    const naturalHeight = Math.max(1, dimensions.height);
    const scale = Math.min(1, maxScreenWidth / naturalWidth, maxScreenHeight / naturalHeight);
    const screenWidth = Math.max(80, naturalWidth * scale);
    const screenHeight = screenWidth * naturalHeight / naturalWidth;
    const width = screenWidth / this.renderer.view.zoom;
    const height = screenHeight / this.renderer.view.zoom;
    return { x: center.x - width / 2, y: center.y - height / 2, width, height };
  }
}

async function readImageDimensions(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const result = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return result;
    } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const result = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("cannot decode image"));
    };
    image.src = url;
  });
}
