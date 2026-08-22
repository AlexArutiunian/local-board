export class ImageCache {
  constructor(onReady) {
    this.onReady = onReady;
    this.entries = new Map();
  }

  get(src) {
    if (!src) return null;
    const existing = this.entries.get(src);
    if (existing) return existing.status === "ready" ? existing.image : null;

    const image = new Image();
    const entry = { image, status: "loading" };
    this.entries.set(src, entry);
    image.decoding = "async";
    image.onload = () => {
      entry.status = "ready";
      this.onReady?.(src);
    };
    image.onerror = () => {
      entry.status = "error";
      this.onReady?.(src);
    };
    image.src = src;
    return null;
  }

  status(src) {
    return this.entries.get(src)?.status || "idle";
  }
}
