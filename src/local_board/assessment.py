
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .assessment_questions import (
    ASSESSMENT_BLOCKS,
    ASSESSMENT_VERSION,
    QUESTION_INDEX,
    is_objective,
    objective_answer_is_correct,
    public_assessment,
    review_questions,
)
from .config import WEB_DIR

SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
OP_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
MAX_ANSWER_CHARS = 20_000
MAX_CLIPBOARD_CHARS = 1_000
MAX_EVENT_BATCH = 100
MAX_EVENT_IDS = 4_096
MAX_PROCESSED_OPS = 512
MAX_JSON_BYTES = 256 * 1024

ALLOWED_EVENT_TYPES = {
    "assessment_started",
    "answer_changed",
    "answer_saved",
    "block_changed",
    "copy",
    "cut",
    "paste",
    "context_menu",
    "print_screen_key",
    "tab_hidden",
    "tab_visible",
    "window_blur",
    "window_focus",
    "fullscreen_enter",
    "fullscreen_exit",
    "submission_started",
    "submission_completed",
}


def _now_ms() -> int:
    return int(time.time() * 1_000)


def _validate_session_id(session_id: str) -> str:
    if not SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(status_code=404, detail="assessment session not found")
    return session_id


def _validate_op_id(value: Any) -> str:
    if not isinstance(value, str) or not OP_ID_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="invalid op_id")
    return value


def _atomic_json_write(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sanitize_answer(question: dict[str, Any], answer: Any) -> Any:
    kind = question["type"]
    if kind == "single":
        if isinstance(answer, bool) or not isinstance(answer, int):
            raise HTTPException(status_code=400, detail="single answer must be an option index")
        if not 0 <= answer < len(question["options"]):
            raise HTTPException(status_code=400, detail="answer option is out of range")
        return answer
    if kind == "multiple":
        if not isinstance(answer, list) or len(answer) > len(question["options"]):
            raise HTTPException(status_code=400, detail="multiple answer must be an option list")
        if any(isinstance(item, bool) or not isinstance(item, int) for item in answer):
            raise HTTPException(status_code=400, detail="answer option must be an integer")
        if any(not 0 <= item < len(question["options"]) for item in answer):
            raise HTTPException(status_code=400, detail="answer option is out of range")
        return sorted(set(answer))
    if not isinstance(answer, str):
        raise HTTPException(status_code=400, detail="text answer must be a string")
    return answer[:MAX_ANSWER_CHARS]


class AssessmentStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "assessments"
        self.sessions_dir = self.root / "sessions"
        self.events_dir = self.root / "events"
        self._lock = threading.RLock()

    def _session_path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{_validate_session_id(session_id)}.json"

    def _events_path(self, session_id: str) -> Path:
        return self.events_dir / f"{_validate_session_id(session_id)}.jsonl"

    def create(self) -> dict[str, Any]:
        now = _now_ms()
        session_id = uuid.uuid4().hex
        document = {
            "version": 1,
            "assessment_version": ASSESSMENT_VERSION,
            "session_id": session_id,
            "status": "in_progress",
            "created_at": now,
            "updated_at": now,
            "submitted_at": None,
            "answers": {},
            "event_counts": {},
            "event_ids": [],
            "processed_ops": {},
            "result": None,
        }
        with self._lock:
            _atomic_json_write(self._session_path(session_id), document)
        return document

    def load(self, session_id: str) -> dict[str, Any]:
        path = self._session_path(session_id)
        with self._lock:
            try:
                with path.open("r", encoding="utf-8") as handle:
                    document = json.load(handle)
            except (FileNotFoundError, json.JSONDecodeError) as exc:
                raise HTTPException(status_code=404, detail="assessment session not found") from exc
        if document.get("assessment_version") != ASSESSMENT_VERSION:
            raise HTTPException(status_code=409, detail="assessment version is no longer supported")
        return document

    def save_answer(
        self,
        session_id: str,
        question_id: str,
        answer: Any,
        *,
        expected_revision: int,
        op_id: str,
    ) -> dict[str, Any]:
        if question_id not in QUESTION_INDEX:
            raise HTTPException(status_code=404, detail="question not found")
        if isinstance(expected_revision, bool) or not isinstance(expected_revision, int):
            raise HTTPException(status_code=400, detail="invalid answer revision")
        clean_answer = _sanitize_answer(QUESTION_INDEX[question_id], answer)
        with self._lock:
            document = self.load(session_id)
            if document["status"] != "in_progress":
                raise HTTPException(status_code=409, detail="assessment is already submitted")

            processed = document.setdefault("processed_ops", {})
            if op_id in processed:
                return processed[op_id]

            current = document["answers"].get(question_id)
            current_revision = int(current.get("revision", 0)) if current else 0
            if current_revision != expected_revision:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "revision_conflict",
                        "current": current,
                    },
                )

            record = {
                "answer": clean_answer,
                "revision": current_revision + 1,
                "updated_at": _now_ms(),
            }
            document["answers"][question_id] = record
            document["updated_at"] = record["updated_at"]
            processed[op_id] = record
            if len(processed) > MAX_PROCESSED_OPS:
                oldest = next(iter(processed))
                processed.pop(oldest, None)
            _atomic_json_write(self._session_path(session_id), document)
            return record

    def append_events(self, session_id: str, events: list[Any]) -> dict[str, Any]:
        if not isinstance(events, list) or not 1 <= len(events) <= MAX_EVENT_BATCH:
            raise HTTPException(status_code=400, detail="invalid event batch")
        with self._lock:
            document = self.load(session_id)
            known_ids = set(document.get("event_ids", []))
            accepted: list[dict[str, Any]] = []
            counts = Counter(document.get("event_counts", {}))
            for raw in events:
                event = _sanitize_event(raw)
                if event["id"] in known_ids:
                    continue
                known_ids.add(event["id"])
                counts[event["type"]] += 1
                accepted.append(event)

            if accepted:
                path = self._events_path(session_id)
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as handle:
                    for event in accepted:
                        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                document["event_counts"] = dict(counts)
                document["event_ids"] = list(known_ids)[-MAX_EVENT_IDS:]
                document["updated_at"] = _now_ms()
                _atomic_json_write(self._session_path(session_id), document)
            return {
                "accepted": len(accepted),
                "event_counts": dict(counts),
            }

    def read_events(self, session_id: str) -> list[dict[str, Any]]:
        self.load(session_id)
        path = self._events_path(session_id)
        events: list[dict[str, Any]] = []
        with self._lock:
            try:
                with path.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(event, dict):
                            events.append(event)
            except FileNotFoundError:
                pass
        return events

    def submit(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            document = self.load(session_id)
            if document["status"] == "submitted":
                return document["result"]
            result = _score(document)
            now = _now_ms()
            document["status"] = "submitted"
            document["submitted_at"] = now
            document["updated_at"] = now
            document["result"] = result
            _atomic_json_write(self._session_path(session_id), document)
            return result


def _sanitize_event(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="invalid telemetry event")
    event_id = _validate_op_id(raw.get("id"))
    event_type = raw.get("type")
    if event_type not in ALLOWED_EVENT_TYPES:
        raise HTTPException(status_code=400, detail="unsupported telemetry event")
    question_id = raw.get("question_id")
    if question_id is not None and question_id not in QUESTION_INDEX:
        raise HTTPException(status_code=400, detail="invalid telemetry question")
    client_time = raw.get("client_time")
    if isinstance(client_time, bool) or not isinstance(client_time, (int, float)):
        client_time = None
    text = raw.get("text")
    if text is not None:
        text = str(text)[:MAX_CLIPBOARD_CHARS]
    raw_text_length = raw.get("text_length", len(text or ""))
    if isinstance(raw_text_length, bool) or not isinstance(raw_text_length, (int, float)):
        raw_text_length = len(text or "")
    text_length = max(0, min(int(raw_text_length), MAX_ANSWER_CHARS))
    return {
        "id": event_id,
        "type": event_type,
        "question_id": question_id,
        "client_time": client_time,
        "server_time": _now_ms(),
        "text": text,
        "text_length": text_length,
        "meta": _sanitize_meta(raw.get("meta")),
    }


def _sanitize_meta(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, Any] = {}
    for key, value in list(raw.items())[:12]:
        safe_key = str(key)[:48]
        if isinstance(value, (str, int, float, bool)) or value is None:
            clean[safe_key] = str(value)[:256] if isinstance(value, str) else value
    return clean


def _score(document: dict[str, Any]) -> dict[str, Any]:
    answers = document.get("answers", {})
    block_results: list[dict[str, Any]] = []
    objective_correct = 0
    objective_total = 0
    manual_answered = 0
    manual_total = 0
    answered_total = 0

    for block in ASSESSMENT_BLOCKS:
        block_correct = 0
        block_objective = 0
        block_manual_answered = 0
        block_manual_total = 0
        for question in block["questions"]:
            record = answers.get(question["id"])
            if record is not None and _answer_has_content(record.get("answer")):
                answered_total += 1
            if is_objective(question):
                block_objective += 1
                objective_total += 1
                if record is not None and objective_answer_is_correct(question, record.get("answer")):
                    block_correct += 1
                    objective_correct += 1
            else:
                block_manual_total += 1
                manual_total += 1
                if record is not None and _answer_has_content(record.get("answer")):
                    block_manual_answered += 1
                    manual_answered += 1
        block_results.append(
            {
                "block_id": block["id"],
                "title": block["title"],
                "objective_correct": block_correct,
                "objective_total": block_objective,
                "manual_answered": block_manual_answered,
                "manual_total": block_manual_total,
            }
        )

    percent = round(100 * objective_correct / objective_total, 1) if objective_total else 0.0
    if percent >= 80:
        provisional_level = "Middle+ по объективной части"
    elif percent >= 65:
        provisional_level = "Кандидат на Middle"
    elif percent >= 50:
        provisional_level = "Strong Junior по объективной части"
    else:
        provisional_level = "Ниже порога Middle"

    return {
        "assessment_version": ASSESSMENT_VERSION,
        "answered_total": answered_total,
        "question_total": len(QUESTION_INDEX),
        "objective_correct": objective_correct,
        "objective_total": objective_total,
        "objective_percent": percent,
        "manual_answered": manual_answered,
        "manual_total": manual_total,
        "manual_review_required": manual_total,
        "provisional_level": provisional_level,
        "block_results": block_results,
        "integrity_summary": document.get("event_counts", {}),
        "note": "Предварительный уровень учитывает только закрытые вопросы. Открытые ответы проверяются по рубрикам.",
    }


def _answer_has_content(answer: Any) -> bool:
    if isinstance(answer, str):
        return bool(answer.strip())
    if isinstance(answer, list):
        return bool(answer)
    return answer is not None


async def _request_json(request: Request, *, max_bytes: int = MAX_JSON_BYTES) -> dict[str, Any]:
    raw_length = request.headers.get("content-length")
    if raw_length and raw_length.isdigit() and int(raw_length) > max_bytes:
        raise HTTPException(status_code=413, detail="request is too large")
    body = await request.body()
    if len(body) > max_bytes:
        raise HTTPException(status_code=413, detail="request is too large")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request must be an object")
    return payload


def _session_payload(document: dict[str, Any]) -> dict[str, Any]:
    return {
        "session_id": document["session_id"],
        "status": document["status"],
        "assessment_version": document["assessment_version"],
        "created_at": document["created_at"],
        "updated_at": document["updated_at"],
        "submitted_at": document["submitted_at"],
        "answers": document["answers"],
        "event_counts": document["event_counts"],
        "result": document["result"],
    }


def build_assessment_router(data_dir: Path) -> APIRouter:
    store = AssessmentStore(data_dir)
    router = APIRouter()

    @router.get("/assessment")
    async def assessment_page() -> FileResponse:
        return FileResponse(WEB_DIR / "assessment.html")

    @router.get("/assessment/review/{session_id}")
    async def assessment_review_page(session_id: str) -> FileResponse:
        store.load(session_id)
        return FileResponse(WEB_DIR / "assessment-review.html")

    @router.get("/api/assessment")
    async def get_assessment() -> dict[str, Any]:
        return public_assessment()

    @router.post("/api/assessment/sessions", status_code=201)
    async def create_assessment_session() -> dict[str, Any]:
        return _session_payload(store.create())

    @router.get("/api/assessment/sessions/{session_id}")
    async def get_assessment_session(session_id: str) -> dict[str, Any]:
        return _session_payload(store.load(session_id))

    @router.put("/api/assessment/sessions/{session_id}/answers/{question_id}")
    async def save_assessment_answer(
        session_id: str,
        question_id: str,
        request: Request,
    ) -> dict[str, Any]:
        payload = await _request_json(request)
        record = store.save_answer(
            session_id,
            question_id,
            payload.get("answer"),
            expected_revision=payload.get("revision"),
            op_id=_validate_op_id(payload.get("op_id")),
        )
        return {"question_id": question_id, **record}

    @router.post("/api/assessment/sessions/{session_id}/events")
    async def save_assessment_events(session_id: str, request: Request) -> dict[str, Any]:
        payload = await _request_json(request)
        return store.append_events(session_id, payload.get("events"))

    @router.post("/api/assessment/sessions/{session_id}/submit")
    async def submit_assessment(session_id: str) -> dict[str, Any]:
        return store.submit(session_id)

    @router.get("/api/assessment/sessions/{session_id}/review")
    async def review_assessment_session(session_id: str) -> dict[str, Any]:
        document = store.load(session_id)
        if document["status"] != "submitted":
            raise HTTPException(status_code=409, detail="assessment is not submitted")
        return {
            **_session_payload(document),
            "events": store.read_events(session_id),
            "questions": review_questions(),
        }

    return router
