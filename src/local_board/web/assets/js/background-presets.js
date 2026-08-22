export const BACKGROUND_PATTERNS = [
  { id: "plain", label: "Чистый лист" },
  { id: "dots", label: "Точки" },
  { id: "grid", label: "Клетка" },
  { id: "fine-grid", label: "Мелкая клетка" },
  { id: "ruled", label: "Линейка" },
  { id: "cornell", label: "Cornell" },
  { id: "isometric", label: "Изометрия" },
];

export const BACKGROUND_TONES = [
  { id: "white", label: "Белый", color: "#ffffff" },
  { id: "warm", label: "Тёплый", color: "#fffaf0" },
  { id: "gray", label: "Серый", color: "#f4f4f5" },
  { id: "blue", label: "Голубой", color: "#f5f9ff" },
  { id: "green", label: "Мятный", color: "#f5fbf7" },
];

export const DEFAULT_BACKGROUND = { pattern: "dots", tone: "white" };

export function normalizeBackground(background) {
  const pattern = BACKGROUND_PATTERNS.some((item) => item.id === background?.pattern)
    ? background.pattern
    : DEFAULT_BACKGROUND.pattern;
  const tone = BACKGROUND_TONES.some((item) => item.id === background?.tone)
    ? background.tone
    : DEFAULT_BACKGROUND.tone;
  return { pattern, tone };
}

export function backgroundToneColor(tone) {
  return BACKGROUND_TONES.find((item) => item.id === tone)?.color || "#ffffff";
}
