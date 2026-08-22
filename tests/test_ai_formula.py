import asyncio
import os
import time

import pytest
from fastapi.testclient import TestClient

import local_board.ai_formula as ai_formula
from local_board.ai_formula import (
    DEFAULT_FORMULA_MODEL,
    FormulaNotFoundError,
    FormulaProviderUnavailableError,
    FormulaRecognitionError,
    extract_latex,
    formula_model_candidates,
    is_no_formula_response,
    validate_formula_image_data_url,
    validate_free_formula_model,
)
from local_board.main import create_app


def test_extract_latex_from_json_and_code_fence():
    assert extract_latex('{"latex":"\\\\frac{a}{b}"}') == r"\frac{a}{b}"
    assert extract_latex('```json\n{"latex":"x^2 + 1"}\n```') == "x^2 + 1"
    assert extract_latex("$x+y$") == "x+y"
    assert extract_latex("```latex\nx^2+1\n```") == "x^2+1"


def test_validate_formula_image_data_url():
    value = "data:image/png;base64,iVBORw0KGgo="
    assert validate_formula_image_data_url(value) == value


def test_formula_models_are_fail_closed_to_free_only():
    assert validate_free_formula_model("google/gemma-4-31b-it:free").endswith(":free")
    assert validate_free_formula_model("stealth/ox-alpha") == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model("openrouter/free") == "openrouter/free"
    with pytest.raises(FormulaRecognitionError):
        validate_free_formula_model("google/gemini-3.1-flash-lite")


def test_formula_candidates_have_only_free_routes_and_fallbacks():
    candidates = formula_model_candidates(DEFAULT_FORMULA_MODEL)
    assert candidates[0] == DEFAULT_FORMULA_MODEL
    assert "dots-studio/dots-3-note-preview:free" in candidates
    assert "openrouter/free" in candidates
    assert len(candidates) == len(set(candidates))
    assert all(item.endswith(":free") or item == "openrouter/free" for item in candidates)


def test_no_formula_sentinel_is_detected():
    assert is_no_formula_response("__NO_FORMULA__")
    assert is_no_formula_response("no formula found")
    assert not is_no_formula_response(r"x^2+1=0")


def test_hedged_formula_ocr_uses_fast_second_free_route(monkeypatch):
    calls = []
    second = "dots-studio/dots-3-note-preview:free"

    async def fake_recognize(image_data_url, *, api_key, model):
        calls.append(model)
        if model == DEFAULT_FORMULA_MODEL:
            await asyncio.sleep(0.12)
            return {"latex": "slow", "model": model, "usage": None}
        if model == second:
            await asyncio.sleep(0.005)
            return {"latex": "x^2+1", "model": model, "usage": None}
        await asyncio.sleep(0.05)
        raise FormulaProviderUnavailableError("unused fallback")

    monkeypatch.setattr(ai_formula, "_recognize_with_model", fake_recognize)
    monkeypatch.setattr(ai_formula, "HEDGE_DELAYS_SECONDS", (0.01, 0.04))
    monkeypatch.setattr(ai_formula, "TOTAL_OCR_TIMEOUT_SECONDS", 0.20)

    started = time.perf_counter()
    result = asyncio.run(
        ai_formula.recognize_formula(
            "data:image/png;base64,iVBORw0KGgo=",
            api_key="test-key",
        )
    )
    elapsed = time.perf_counter() - started

    assert result["latex"] == "x^2+1"
    assert result["model"] == second
    assert DEFAULT_FORMULA_MODEL in calls
    assert second in calls
    assert elapsed < 0.08, "second route should win without waiting for slow primary"
    assert result["elapsed_ms"] < 80


def test_formula_endpoint_requires_server_side_key(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.post(
            f"/api/boards/{room_id}/ai/formula",
            json={"image": "data:image/png;base64,iVBORw0KGgo="},
        )
    assert response.status_code == 503
    assert "OPENROUTER_API_KEY" in response.json()["detail"]
    assert "OPENROUTER_API_KEY" not in os.environ


def test_formula_endpoint_distinguishes_no_formula_from_provider_outage(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    app = create_app(tmp_path)

    async def no_formula(*args, **kwargs):
        raise FormulaNotFoundError("В выделенной области не удалось найти формулу")

    monkeypatch.setattr("local_board.main.recognize_formula", no_formula)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.post(
            f"/api/boards/{room_id}/ai/formula",
            json={"image": "data:image/png;base64,iVBORw0KGgo="},
        )
    assert response.status_code == 422

    async def unavailable(*args, **kwargs):
        raise FormulaProviderUnavailableError("Бесплатные OCR-модели временно недоступны")

    monkeypatch.setattr("local_board.main.recognize_formula", unavailable)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.post(
            f"/api/boards/{room_id}/ai/formula",
            json={"image": "data:image/png;base64,iVBORw0KGgo="},
        )
    assert response.status_code == 503
