const root = document.querySelector("#review");
const sessionId = location.pathname.split("/").filter(Boolean).at(-1);

void loadReview();

async function loadReview() {
  try {
    const response = await fetch(
      `/api/assessment/sessions/${encodeURIComponent(sessionId)}/review`,
    );
    if (!response.ok) throw new Error(await responseMessage(response));
    render(await response.json());
  } catch (error) {
    root.replaceChildren();
    const panel = el("section", "panel review-section");
    append(panel, "h1", "Не удалось открыть отчёт");
    append(panel, "p", error.message, "error");
    root.append(panel);
  }
}

function render(data) {
  root.replaceChildren();
  root.append(renderSummary(data), renderSignals(data), renderAnswers(data), renderEvents(data));
}

function renderSummary(data) {
  const section = el("section", "panel review-section");
  append(section, "p", `Сессия ${data.session_id}`, "eyebrow");
  append(section, "h1", data.result.provisional_level);
  append(section, "p", data.result.note);
  const metrics = el("div", "result-grid");
  addMetric(metrics, `${data.result.objective_percent}%`, "Закрытая часть");
  addMetric(metrics, `${data.result.answered_total}/100`, "Заполнено");
  addMetric(metrics, String(data.events.length), "Событий в журнале");
  section.append(metrics);
  return section;
}

function renderSignals(data) {
  const section = el("section", "panel review-section");
  append(section, "h2", "Сводка действий");
  append(
    section,
    "p",
    "Сигналы являются контекстом для проверки, а не автоматическим доказательством нарушения.",
    "privacy-warning",
  );
  const grid = el("div", "signal-grid");
  const labels = {
    tab_hidden: "Уходов со вкладки",
    window_blur: "Потерь фокуса",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    context_menu: "Контекстное меню",
    print_screen_key: "PrintScreen signal",
    fullscreen_exit: "Выходов из fullscreen",
  };
  for (const [key, label] of Object.entries(labels)) {
    const item = el("div", "signal");
    append(item, "strong", String(data.event_counts[key] || 0));
    append(item, "span", label, "muted");
    grid.append(item);
  }
  section.append(grid);
  return section;
}

function renderAnswers(data) {
  const section = el("section", "panel review-section");
  append(section, "h2", "Ответы и рубрики");
  for (const block of data.result.block_results) {
    append(section, "h2", block.title);
    for (const question of data.questions.filter((item) => item.block_id === block.block_id)) {
      const record = data.answers[question.id];
      const card = el("article", "answer-card");
      append(card, "span", `${question.id} · ${typeLabel(question.type)}`, "muted");
      append(card, "h3", question.prompt);
      const value = record?.answer;
      const objective = question.type === "single" || question.type === "multiple";
      if (objective) {
        const correct = objectiveCorrect(question, value);
        card.classList.add(correct ? "answer-correct" : "answer-wrong");
        append(card, "p", `Ответ: ${formatObjective(question, value)}`, "answer-value");
        append(card, "p", `Правильно: ${formatObjective(question, question.answer)}`, "rubric");
      } else {
        append(card, "p", value || "Нет ответа", "answer-value");
      }
      const list = el("ul", "rubric");
      for (const criterion of question.rubric) append(list, "li", criterion);
      card.append(list);
      section.append(card);
    }
  }
  return section;
}

function renderEvents(data) {
  const section = el("section", "panel review-section");
  append(section, "h2", "Хронология действий");
  const list = el("div", "event-list");
  for (const event of data.events) {
    const row = el("div", "event-row");
    append(row, "time", new Date(event.server_time).toLocaleString("ru-RU"));
    append(row, "strong", event.type);
    const details = el("div", "event-text");
    const parts = [];
    if (event.question_id) parts.push(event.question_id);
    if (event.text != null) parts.push(`text: ${JSON.stringify(event.text)}`);
    if (event.text_length) parts.push(`length: ${event.text_length}`);
    if (Object.keys(event.meta || {}).length) parts.push(JSON.stringify(event.meta));
    details.textContent = parts.join(" | ") || "-";
    row.append(details);
    list.append(row);
  }
  if (!data.events.length) append(list, "p", "Журнал пуст.", "muted");
  section.append(list);
  return section;
}

function objectiveCorrect(question, value) {
  if (question.type === "single") return value === question.answer;
  if (!Array.isArray(value)) return false;
  return JSON.stringify([...new Set(value)].sort()) === JSON.stringify([...question.answer].sort());
}

function formatObjective(question, value) {
  if (question.type === "single") {
    return Number.isInteger(value) ? question.options[value] : "Нет ответа";
  }
  if (!Array.isArray(value) || !value.length) return "Нет ответа";
  return value.map((index) => question.options[index]).join("; ");
}

function typeLabel(type) {
  return {
    single: "один вариант",
    multiple: "несколько вариантов",
    short: "текст",
    code: "код",
    scenario: "сценарий",
  }[type];
}

function addMetric(parent, value, label) {
  const metric = el("div", "metric");
  append(metric, "strong", value);
  append(metric, "span", label, "muted");
  parent.append(metric);
}

function el(tag, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function append(parent, tag, text, className = "") {
  const element = el(tag, className);
  element.textContent = text;
  parent.append(element);
  return element;
}

async function responseMessage(response) {
  try {
    const payload = await response.json();
    return typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
  } catch {
    return `HTTP ${response.status}`;
  }
}
