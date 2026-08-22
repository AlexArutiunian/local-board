import { backgroundToneColor, normalizeBackground } from "./background-presets.js";

export function installBoardBackground(renderer, state) {
  renderer.drawGridTo = (ctx, width, height) => drawBoardBackground(ctx, width, height, renderer.view, state.background);
}

export function drawBoardBackground(ctx, width, height, view, rawBackground) {
  const background = normalizeBackground(rawBackground);
  const paper = backgroundToneColor(background.tone);
  const line = lineColorForTone(background.tone);
  ctx.save();
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);

  if (background.pattern === "plain") {
    ctx.restore();
    return;
  }

  if (background.pattern === "dots") drawDots(ctx, width, height, view, line);
  else if (background.pattern === "grid") drawGrid(ctx, width, height, view, line, 28, false);
  else if (background.pattern === "fine-grid") drawGrid(ctx, width, height, view, line, 18, true);
  else if (background.pattern === "ruled") drawRuled(ctx, width, height, view, line);
  else if (background.pattern === "cornell") drawCornell(ctx, width, height, view, line);
  else if (background.pattern === "isometric") drawIsometric(ctx, width, height, view, line);
  ctx.restore();
}

function drawDots(ctx, width, height, view, color) {
  const spacing = 28 * view.zoom;
  if (spacing < 9) return;
  const startX = modulo(view.x, spacing);
  const startY = modulo(view.y, spacing);
  ctx.fillStyle = color;
  const radius = clamp(view.zoom, 0.65, 1.15);
  for (let x = startX; x < width; x += spacing) {
    for (let y = startY; y < height; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawGrid(ctx, width, height, view, color, worldSpacing, major) {
  const spacing = worldSpacing * view.zoom;
  if (spacing < 6) return;
  const startX = modulo(view.x, spacing);
  const startY = modulo(view.y, spacing);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (let x = startX; x <= width; x += spacing) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = startY; y <= height; y += spacing) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();

  if (!major || spacing * 5 < 24) return;
  const majorSpacing = spacing * 5;
  ctx.strokeStyle = stronger(color);
  ctx.beginPath();
  for (let x = modulo(view.x, majorSpacing); x <= width; x += majorSpacing) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = modulo(view.y, majorSpacing); y <= height; y += majorSpacing) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

function drawRuled(ctx, width, height, view, color) {
  const spacing = 32 * view.zoom;
  if (spacing < 8) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = modulo(view.y, spacing); y <= height; y += spacing) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

function drawCornell(ctx, width, height, view, color) {
  drawRuled(ctx, width, height, view, color);
  const marginX = 150 * view.zoom + view.x;
  const headerY = 96 * view.zoom + view.y;
  ctx.strokeStyle = stronger(color);
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (marginX > 0 && marginX < width) {
    ctx.moveTo(Math.round(marginX) + 0.5, 0);
    ctx.lineTo(Math.round(marginX) + 0.5, height);
  }
  if (headerY > 0 && headerY < height) {
    ctx.moveTo(0, Math.round(headerY) + 0.5);
    ctx.lineTo(width, Math.round(headerY) + 0.5);
  }
  ctx.stroke();
}

function drawIsometric(ctx, width, height, view, color) {
  const spacing = 32 * view.zoom;
  if (spacing < 10) return;
  const vertical = spacing * Math.sqrt(3) / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const offsetY = modulo(view.y, vertical);
  const offsetX = modulo(view.x, spacing);
  const span = width + height * 0.7 + spacing * 4;

  ctx.beginPath();
  for (let y = offsetY - vertical * 2; y < height + vertical * 2; y += vertical) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  for (let x = offsetX - span; x < width + span; x += spacing) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height * 0.57735, height);
    ctx.moveTo(x, height);
    ctx.lineTo(x + height * 0.57735, 0);
  }
  ctx.stroke();
}

function lineColorForTone(tone) {
  if (tone === "blue") return "rgba(92,132,181,.22)";
  if (tone === "green") return "rgba(79,132,102,.20)";
  if (tone === "warm") return "rgba(139,116,82,.20)";
  return "rgba(120,113,108,.20)";
}

function stronger(color) {
  return color.replace(/\.2\d?\)/, ".34)").replace(/\.20\)/, ".34)").replace(/\.22\)/, ".34)");
}

function modulo(value, base) { return ((value % base) + base) % base; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
