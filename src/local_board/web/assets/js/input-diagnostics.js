export function createInputDiagnostics() {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  if (params.get("inputDebug") !== "1") return null;

  const panel = document.createElement("pre");
  panel.setAttribute("aria-hidden", "true");
  Object.assign(panel.style, {
    position: "fixed",
    top: "64px",
    left: "8px",
    zIndex: "99999",
    width: "min(520px, calc(100vw - 16px))",
    maxHeight: "38vh",
    overflow: "hidden",
    margin: "0",
    padding: "8px",
    borderRadius: "8px",
    background: "rgba(0,0,0,.78)",
    color: "#fff",
    font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
    pointerEvents: "none",
    userSelect: "none",
    whiteSpace: "pre-wrap",
  });
  document.body.appendChild(panel);

  const lines = [];
  const startedAt = performance.now();

  function push(text) {
    const t = (performance.now() - startedAt).toFixed(1).padStart(7, " ");
    lines.push(`${t} ${text}`);
    while (lines.length > 24) lines.shift();
    panel.textContent = lines.join("\n");
  }

  push("input diagnostics enabled");

  return {
    pointer(label, event) {
      push(
        `${label} ${event.type || "pointer"} type=${event.pointerType || "?"}`
        + ` id=${event.pointerId} p=${number(event.pressure)}`
        + ` b=${event.buttons ?? "?"} x=${round(event.clientX)} y=${round(event.clientY)}`,
      );
    },
    touch(label, touch) {
      push(
        `${label} touch type=${touch?.touchType || "?"} id=${touch?.identifier ?? "?"}`
        + ` f=${number(touch?.force)} x=${round(touch?.clientX)} y=${round(touch?.clientY)}`,
      );
    },
    note(label) {
      push(label);
    },
  };
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "?";
}

function round(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : "?";
}
