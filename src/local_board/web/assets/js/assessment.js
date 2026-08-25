
import { AssessmentTelemetry } from "./assessment-telemetry.js";

const SESSION_KEY = "local-board-assessment-session-v1";
const state = {
  assessment: null,
  session: null,
  blockIndex: 0,
  questionIndex: 0,
  answers: {},
  saveTimers: new Map(),
  saveChains: new Map(),
};

const elements = {
  intro: document.querySelector("#intro"),
  workspace: document.querySelector("#workspace"),
  result: document.querySelector("#result"),
  consent: document.querySelector("#consent"),
  start: document.querySelector("#start-button"),
  resume: document.querySelector("#resume-button"),
  introError: document.querySelector("#intro-error"),
  sessionLabel: document.querySelector("#session-label"),
  saveStatus: document.querySelector("#save-status"),
  blockNav: document.querySelector("#block-nav"),
  questionCard: document.querySelector("#question-card"),
  previous: document.querySelector("#previous-button"),
  next: document.querySelector("#next-button"),
  position: document.querySelector("#question-position"),
  progressLabel: document.querySelector("#progress-label"),
  progressBar: document.querySelector("#progress-bar"),
  submit: document.querySelector("#submit-button"),
  submitDialog: document.querySelector("#submit-dialog"),
  submitSummary: document.querySelector("#submit-summary"),
  confirmSubmit: document.querySelector("#confirm-submit"),
};

const telemetry = new AssessmentTelemetry({
  getSessionId: () => state.session?.session_id || null,
  getQuestionId: () => currentQuestion()?.id || null,
});

elements.consent.addEventListener("change", () => {
  elements.start.disabled = !elements.consent.checked;
});
elements.start.addEventListener("click", () => void startNewSession());
elements.resume.addEventListener("click", () => void resumeStoredSession());
elements.previous.addEventListener("click", () => void navigateBy(-1));
elements.next.addEventListener("click", () => void navigateBy(1));
elements.submit.addEventListener("click", openSubmitDialog);
elements.submitDialog.addEventListener("close", () => {
  if (elements.submitDialog.returnValue === "confirm") void submitAssessment();
});

void initialize();

async function initialize() {
  try {
    state.assessment = await requestJson("/api/assessment");
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
      elements.resume.classList.remove("hidden");
      elements.resume.dataset.sessionId = stored;
    }
  } catch (error) {
    elements.introError.textContent = error.message;
  }
}

async function startNewSession() {
  elements.start.disabled = true;
  elements.introError.textContent = "";
  try {
    const session = await requestJson("/api/assessment/sessions", { method: "POST" });
    activateSession(session);
    telemetry.record("assessment_started");
  } catch (error) {
    elements.introError.textContent = error.message;
    elements.start.disabled = !elements.consent.checked;
  }
}

async function resumeStoredSession() {
  const sessionId = elements.resume.dataset.sessionId;
  if (!sessionId) return;
  elements.resume.disabled = true;
  elements.introError.textContent = "";
  try {
    const session = await requestJson(
      `/api/assessment/sessions/${encodeURIComponent(sessionId)}`,
    );
    activateSession(session);
  } catch (error) {
    localStorage.removeItem(SESSION_KEY);
    elements.resume.classList.add("hidden");
    elements.introError.textContent = error.message;
  } finally {
    elements.resume.disabled = false;
  }
}

function activateSession(session) {
  state.session = session;
  state.answers = structuredClone(session.answers || {});
  localStorage.setItem(SESSION_KEY, session.session_id);
  elements.sessionLabel.textContent = `Сессия ${session.session_id.slice(0, 8)}`;
  elements.intro.classList.add("hidden");
  if (session.status === "submitted" && session.result) {
    showResult(session.result);
    return;
  }
  elements.workspace.classList.remove("hidden");
  elements.saveStatus.textContent = "Все изменения сохранены";
  telemetry.start();
  render();
}

function render() {
  renderBlockNav();
  renderQuestion();
  renderProgress();
}

function renderBlockNav() {
  elements.blockNav.replaceChildren();
  state.assessment.blocks.forEach((block, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `block-button${index === state.blockIndex ? " active" : ""}`;
    const answered = block.questions.filter((question) => hasAnswer(question.id)).length;
    appendText(button, "span", String(index + 1), "block-number");
    appendText(button, "span", block.title);
    appendText(button, "span", `${answered}/10`, "block-score");
    button.addEventListener("click", () => void goTo(index, 0));
    elements.blockNav.append(button);
  });
}

function renderQuestion() {
  const block = currentBlock();
  const question = currentQuestion();
  const card = elements.questionCard;
  card.replaceChildren();
  card.dataset.questionId = question.id;

  const meta = document.createElement("div");
  meta.className = "question-meta";
  appendText(meta, "span", `Блок ${state.blockIndex + 1}: ${block.title}`, "pill");
  appendText(meta, "span", typeLabel(question.type), "pill");
  if (question.type === "multiple") {
    appendText(meta, "span", "Можно выбрать несколько", "pill");
  }
  card.append(meta);
  appendText(card, "h1", question.prompt);

  const record = state.answers[question.id];
  const value = record?.answer;
  if (question.type === "single" || question.type === "multiple") {
    renderOptions(card, question, value);
  } else {
    renderTextAnswer(card, question, typeof value === "string" ? value : "");
  }

  const flatPosition = state.blockIndex * 10 + state.questionIndex + 1;
  elements.position.textContent = `Вопрос ${flatPosition} из ${state.assessment.question_count}`;
  elements.previous.disabled = flatPosition === 1;
  elements.next.textContent =
    flatPosition === state.assessment.question_count ? "К завершению" : "Дальше";
}

function renderOptions(card, question, currentValue) {
  const wrapper = document.createElement("div");
  wrapper.className = "options";
  question.options.forEach((text, index) => {
    const label = document.createElement("label");
    label.className = "option";
    const input = document.createElement("input");
    input.type = question.type === "single" ? "radio" : "checkbox";
    input.name = question.id;
    input.value = String(index);
    input.checked =
      question.type === "single"
        ? currentValue === index
        : Array.isArray(currentValue) && currentValue.includes(index);
    input.addEventListener("change", () => {
      if (question.type === "single") {
        setLocalAnswer(question.id, index);
      } else {
        const chosen = [...wrapper.querySelectorAll("input:checked")].map((item) =>
          Number(item.value),
        );
        setLocalAnswer(question.id, chosen);
      }
    });
    label.append(input, document.createTextNode(text));
    wrapper.append(label);
  });
  card.append(wrapper);
}

function renderTextAnswer(card, question, currentValue) {
  if (question.starter) {
    const starter = document.createElement("pre");
    starter.className = "starter";
    starter.textContent = question.starter;
    card.append(starter);
  }
  const textarea = document.createElement("textarea");
  textarea.className = `answer-editor${question.type === "code" ? " code-editor" : ""}`;
  textarea.value = currentValue;
  textarea.placeholder =
    question.type === "code"
      ? "Напишите код или подробный псевдокод..."
      : "Сформулируйте ответ своими словами...";
  textarea.addEventListener("input", () => setLocalAnswer(question.id, textarea.value));
  if (question.type === "code") {
    textarea.addEventListener("keydown", insertIndentOnTab);
  }
  card.append(textarea);
  appendText(
    card,
    "p",
    "Открытый ответ сохраняется автоматически и проверяется по рубрике.",
    "helper",
  );
  requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
}

function setLocalAnswer(questionId, answer) {
  const previous = state.answers[questionId] || { revision: 0 };
  state.answers[questionId] = { ...previous, answer, dirty: true };
  elements.saveStatus.textContent = "Сохранение...";
  renderProgress();
  renderBlockNav();
  scheduleSave(questionId);
}

function scheduleSave(questionId) {
  const existing = state.saveTimers.get(questionId);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    state.saveTimers.delete(questionId);
    queueSave(questionId);
  }, 650);
  state.saveTimers.set(questionId, timer);
}

function queueSave(questionId) {
  const previous = state.saveChains.get(questionId) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => saveAnswer(questionId))
    .finally(() => {
      if (state.saveChains.get(questionId) === next) state.saveChains.delete(questionId);
    });
  state.saveChains.set(questionId, next);
  return next;
}

async function saveAnswer(questionId, retry = true) {
  const record = state.answers[questionId];
  if (!record?.dirty) return;
  const response = await fetch(
    `/api/assessment/sessions/${encodeURIComponent(state.session.session_id)}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answer: record.answer,
        revision: record.revision || 0,
        op_id: makeOperationId("answer"),
      }),
    },
  );
  if (response.status === 409 && retry) {
    const conflict = await response.json();
    const current = conflict.detail?.current;
    state.answers[questionId].revision = current?.revision || 0;
    return saveAnswer(questionId, false);
  }
  if (!response.ok) throw new Error(await responseMessage(response));
  const saved = await response.json();
  state.answers[questionId].revision = saved.revision;
  state.answers[questionId].updated_at = saved.updated_at;
  state.answers[questionId].dirty = false;
  telemetry.record("answer_changed", {
    questionId,
    meta: { revision: saved.revision, answer_length: answerLength(record.answer) },
  });
  telemetry.record("answer_saved", { questionId, meta: { revision: saved.revision } });
  elements.saveStatus.textContent = "Все изменения сохранены";
}

async function flushPendingAnswers() {
  for (const [questionId, timer] of state.saveTimers) {
    window.clearTimeout(timer);
    state.saveTimers.delete(questionId);
    queueSave(questionId);
  }
  await Promise.all([...state.saveChains.values()]);
}

async function navigateBy(delta) {
  const flat = state.blockIndex * 10 + state.questionIndex;
  const target = Math.max(0, Math.min(state.assessment.question_count - 1, flat + delta));
  if (target === flat && delta > 0) {
    openSubmitDialog();
    return;
  }
  await goTo(Math.floor(target / 10), target % 10);
}

async function goTo(blockIndex, questionIndex) {
  const oldBlock = state.blockIndex;
  state.blockIndex = blockIndex;
  state.questionIndex = questionIndex;
  if (oldBlock !== blockIndex) {
    telemetry.record("block_changed", { meta: { from: oldBlock, to: blockIndex } });
  }
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderProgress() {
  const count = Object.keys(state.answers).filter(hasAnswer).length;
  elements.progressLabel.textContent = `${count} / ${state.assessment.question_count}`;
  elements.progressBar.style.width = `${(100 * count) / state.assessment.question_count}%`;
}

function openSubmitDialog() {
  const answered = Object.keys(state.answers).filter(hasAnswer).length;
  const missing = state.assessment.question_count - answered;
  elements.submitSummary.textContent = missing
    ? `Без ответа осталось: ${missing}. После завершения изменить ответы нельзя.`
    : "Все 100 заданий заполнены. После завершения изменить ответы нельзя.";
  elements.submitDialog.showModal();
}

async function submitAssessment() {
  elements.submit.disabled = true;
  elements.saveStatus.textContent = "Завершение...";
  try {
    await flushPendingAnswers();
    telemetry.record("submission_started");
    await telemetry.flush();
    const result = await requestJson(
      `/api/assessment/sessions/${encodeURIComponent(state.session.session_id)}/submit`,
      { method: "POST" },
    );
    telemetry.record("submission_completed");
    await telemetry.flush();
    state.session.status = "submitted";
    state.session.result = result;
    showResult(result);
  } catch (error) {
    elements.saveStatus.textContent = "Ошибка сохранения";
    alert(error.message);
    elements.submit.disabled = false;
  }
}

function showResult(result) {
  telemetry.stop();
  elements.workspace.classList.add("hidden");
  elements.result.classList.remove("hidden");
  elements.result.replaceChildren();
  appendText(elements.result, "p", "Попытка завершена", "eyebrow");
  appendText(elements.result, "h1", result.provisional_level);
  appendText(elements.result, "p", result.note);

  const metrics = document.createElement("div");
  metrics.className = "result-grid";
  addMetric(metrics, `${result.objective_percent}%`, "Закрытая часть");
  addMetric(metrics, `${result.answered_total}/${result.question_total}`, "Всего заполнено");
  addMetric(metrics, `${result.manual_answered}/${result.manual_total}`, "Открытых заполнено");
  elements.result.append(metrics);

  const table = document.createElement("table");
  table.className = "result-table";
  const head = table.createTHead().insertRow();
  for (const title of ["Блок", "Закрытые", "Открытые"]) appendText(head, "th", title);
  const body = table.createTBody();
  for (const block of result.block_results) {
    const row = body.insertRow();
    appendText(row, "td", block.title);
    appendText(row, "td", `${block.objective_correct}/${block.objective_total}`);
    appendText(row, "td", `${block.manual_answered}/${block.manual_total}`);
  }
  elements.result.append(table);

  const link = document.createElement("a");
  link.className = "primary review-link";
  link.href = `/assessment/review/${encodeURIComponent(state.session.session_id)}`;
  link.textContent = "Открыть отчёт с журналом и рубриками";
  elements.result.append(link);
  elements.saveStatus.textContent = "Завершено";
}

function addMetric(parent, value, label) {
  const metric = document.createElement("div");
  metric.className = "metric";
  appendText(metric, "strong", value);
  appendText(metric, "span", label, "muted");
  parent.append(metric);
}

function currentBlock() {
  return state.assessment?.blocks[state.blockIndex] || null;
}

function currentQuestion() {
  return currentBlock()?.questions[state.questionIndex] || null;
}

function hasAnswer(questionId) {
  const answer = state.answers[questionId]?.answer;
  if (typeof answer === "string") return Boolean(answer.trim());
  if (Array.isArray(answer)) return answer.length > 0;
  return answer !== undefined && answer !== null;
}

function answerLength(answer) {
  if (typeof answer === "string" || Array.isArray(answer)) return answer.length;
  return answer == null ? 0 : 1;
}

function typeLabel(type) {
  return {
    single: "Один вариант",
    multiple: "Несколько вариантов",
    short: "Короткий ответ",
    code: "Код",
    scenario: "Инженерный сценарий",
  }[type];
}

function insertIndentOnTab(event) {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const target = event.currentTarget;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  target.setRangeText("    ", start, end, "end");
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function appendText(parent, tag, text, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function makeOperationId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json();
}

async function responseMessage(response) {
  try {
    const payload = await response.json();
    return typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
  } catch {
    return `HTTP ${response.status}`;
  }
}

