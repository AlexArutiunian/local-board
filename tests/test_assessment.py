from fastapi.testclient import TestClient

from local_board.assessment_questions import (
    ASSESSMENT_BLOCKS,
    QUESTION_INDEX,
    public_assessment,
)
from local_board.main import create_app


def test_assessment_catalog_is_exactly_ten_blocks_of_ten_without_answer_leakage():
    payload = public_assessment()

    assert payload["question_count"] == 100
    assert len(payload["blocks"]) == 10
    assert all(len(block["questions"]) == 10 for block in payload["blocks"])
    assert set(question["type"] for block in payload["blocks"] for question in block["questions"]) == {
        "single",
        "multiple",
        "short",
        "code",
        "scenario",
    }
    assert all(
        "answer" not in question and "rubric" not in question
        for block in payload["blocks"]
        for question in block["questions"]
    )


def test_answer_save_is_revisioned_idempotent_and_resumable(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        session_id = client.post("/api/assessment/sessions").json()["session_id"]
        path = f"/api/assessment/sessions/{session_id}/answers/python-01"
        first = client.put(
            path,
            json={"answer": 1, "revision": 0, "op_id": "answer-op-1"},
        )
        assert first.status_code == 200
        assert first.json()["revision"] == 1

        duplicate = client.put(
            path,
            json={"answer": 0, "revision": 0, "op_id": "answer-op-1"},
        )
        assert duplicate.status_code == 200
        assert duplicate.json()["revision"] == 1

        conflict = client.put(
            path,
            json={"answer": 0, "revision": 0, "op_id": "answer-op-2"},
        )
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "revision_conflict"

    restarted = create_app(tmp_path)
    with TestClient(restarted) as client:
        resumed = client.get(f"/api/assessment/sessions/{session_id}")
        assert resumed.status_code == 200
        assert resumed.json()["answers"]["python-01"]["answer"] == 1
        assert resumed.json()["answers"]["python-01"]["revision"] == 1


def test_telemetry_is_deduplicated_bounded_and_available_in_review(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        session_id = client.post("/api/assessment/sessions").json()["session_id"]
        event = {
            "id": "event-paste-1",
            "type": "paste",
            "question_id": "python-09",
            "client_time": 123,
            "text": "x" * 1500,
            "text_length": 1500,
            "meta": {"source": "clipboard"},
        }
        endpoint = f"/api/assessment/sessions/{session_id}/events"
        saved = client.post(endpoint, json={"events": [event, event]})
        assert saved.status_code == 200
        assert saved.json()["accepted"] == 1
        assert saved.json()["event_counts"]["paste"] == 1

        before_submit = client.get(f"/api/assessment/sessions/{session_id}/review")
        assert before_submit.status_code == 409

        result = client.post(f"/api/assessment/sessions/{session_id}/submit")
        assert result.status_code == 200
        review = client.get(f"/api/assessment/sessions/{session_id}/review")
        assert review.status_code == 200
        payload = review.json()
        assert len(payload["events"]) == 1
        assert payload["events"][0]["text"] == "x" * 1000
        assert payload["events"][0]["text_length"] == 1500
        assert payload["event_counts"]["paste"] == 1
        assert "rubric" in payload["questions"][0]


def test_submission_scores_objective_answers_and_locks_session(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        session_id = client.post("/api/assessment/sessions").json()["session_id"]
        objective = next(question for question in QUESTION_INDEX.values() if "answer" in question)
        manual = next(question for question in QUESTION_INDEX.values() if "answer" not in question)

        for question, answer, op_id in (
            (objective, objective["answer"], "objective-save"),
            (manual, "Подробный инженерный ответ", "manual-save"),
        ):
            response = client.put(
                f"/api/assessment/sessions/{session_id}/answers/{question['id']}",
                json={"answer": answer, "revision": 0, "op_id": op_id},
            )
            assert response.status_code == 200

        result = client.post(f"/api/assessment/sessions/{session_id}/submit")
        assert result.status_code == 200
        payload = result.json()
        assert payload["question_total"] == 100
        assert payload["objective_total"] == 60
        assert payload["objective_correct"] == 1
        assert payload["manual_total"] == 40
        assert payload["manual_answered"] == 1

        locked = client.put(
            f"/api/assessment/sessions/{session_id}/answers/{objective['id']}",
            json={"answer": objective["answer"], "revision": 1, "op_id": "late-save"},
        )
        assert locked.status_code == 409


def test_assessment_pages_and_invalid_input_boundaries(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        assert client.get("/assessment").status_code == 200
        assert client.get("/api/assessment").status_code == 200
        assert client.get("/api/assessment/sessions/not-a-session").status_code == 404

        session_id = client.post("/api/assessment/sessions").json()["session_id"]
        bad_question = client.put(
            f"/api/assessment/sessions/{session_id}/answers/no-such-question",
            json={"answer": "x", "revision": 0, "op_id": "bad-question"},
        )
        assert bad_question.status_code == 404
        bad_event = client.post(
            f"/api/assessment/sessions/{session_id}/events",
            json={"events": [{"id": "bad-event", "type": "screen_contents"}]},
        )
        assert bad_event.status_code == 400


def test_question_ids_are_unique_and_block_ids_match_content():
    question_ids = [
        question["id"]
        for block in ASSESSMENT_BLOCKS
        for question in block["questions"]
    ]
    assert len(question_ids) == len(set(question_ids)) == 100
    assert set(question_ids) == set(QUESTION_INDEX)
