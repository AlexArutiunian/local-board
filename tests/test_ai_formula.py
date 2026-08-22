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
    extract_json_latex,
    extract_latex,
    formula_model_candidates,
    is_no_formula_response,
    looks_like_non_formula_output,
    validate_formula_image_data_url,
    validate_free_formula_model,
)
from local_board.main import create_app


def test_extract_latex_from_json_and_code_fence():
    assert extract_latex('{"latex":"\\\\frac{a}{b}"}') == r"\frac{a}{b}"
    assert extract_latex('```json\n{"latex":"x^2 + 1"}\n```') == "x^2 + 1"
    assert extract_latex("$x+y$") == "x+y"
    assert extract_latex("```latex\nx^2+1\n```") == "x^2+1"
    assert extract_json_latex('{"latex":"x^2-2x+1=0"}') == "x^2-2x+1=0"
    assert extract_json_latex("UserSafety: safe") == ""


def test_validate_formula_image_data_url():
    value = "data:image/png;base64,iVBORw0KGgo="
    assert validate_formula_image_data_url(value) == value


def test_formula_models_are_fail_closed_to_free_only():
    assert DEFAULT_FORMULA_MODEL.endswith(":free")
    assert validate_free_formula_model("google/gemma-4-31b-it-20260402:free").endswith(":free")
    assert validate_free_formula_model("stealth/ox-alpha") == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model(
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    ) == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model("openrouter/free") == DEFAULT_FORMULA_MODEL
    with pytest.raises(FormulaRecognitionError):
        validate_free_formula_model("google/gemini-3.1-flash-lite")


def test_formula_candidates_are_only_explicit_free_gemma_routes():
    candidates = formula_model_candidates(DEFAULT_FORMULA_MODEL)
    assert candidates == [
        DEFAULT_FORMULA_MODEL,
        "google/gemma-4-26b-a4b-it:free",
    ]
    assert all(item.endswith(":free") for item in candidates)
    assert all("gemma-4" in item for item in candidates)


def test_no_formula_and_safety_output_detection():
    assert is_no_formula_response("__NO_FORMULA__")
    assert is_no_formula_response("no formula found")
    assert not is_no_formula_response(r"x^2+1=0")
    assert looks_like_non_formula_output("UserSafety: safe")
    assert looks_like_non_formula_output("unsafe category: something")
    assert not looks_like_non_formula_output(r"x^2-2x+1=0")


def test_hedged_formula_ocr_uses_second_gemma_only_when_primary_is_slow(monkeypatch):
    calls = []
    second = "google/gemma-4-26b-a4b-it:free"

    async def fake_recognize(image_data_url, *, api_key, model):
        calls.append(model)
        if model == DEFAULT_FORMULA_MODEL:
            await asyncio.sleep(0.12)
            return {"latex": "x^2-2x+1=0", "model": model, "usage": None}
        if model == second:
            await asyncio.sleep(0.005)
            return {"latex": "x^2-2x+1=0", "model": model, "usage": None}
        raise AssertionError(f"unexpected model {model}")

    monkeypatch.setattr(ai_formula, "_recognize_with_model", fake_recognize)
    monkeypatch.setattr(ai_formula, "FALLBACK_HEDGE_SECONDS", 0.01)
    monkeypatch.setattr(ai_formula, "TOTAL_OCR_TIMEOUT_SECONDS", 0.20)

    started = time.perf_counter()
    result = asyncio.run(
        ai_formula.recognize_formula(
            "data:image/png;base64,iVBORw0KGgo=",
            api_key="test-key",
        )
    )
    elapsed = time.perf_counter() - started

    assert result["latex"] == "x^2-2x+1=0"
    assert result["model"] == second
    assert calls[:2] == [DEFAULT_FORMULA_MODEL, second]
    assert elapsed < 0.08
    assert result["elapsed_ms"] < 80


def test_fast_primary_does_not_launch_fallback(monkeypatch):
    calls = []

    async def fake_recognize(image_data_url, *, api_key, model):
        calls.append(model)
        await asyncio.sleep(0.001)
        return {"latex": "2x+4=0", "model": model, "usage": None}

    monkeypatch.setattr(ai_formula, "_recognize_with_model", fake_recognize)
    monkeypatch.setattr(ai_formula, "FALLBACK_HEDGE_SECONDS", 0.05)
    monkeypatch.setattr(ai_formula, "TOTAL_OCR_TIMEOUT_SECONDS", 0.20)

    result = asyncio.run(
        ai_formula.recognize_formula(
            "data:image/png;base64,iVBORw0KGgo=",
            api_key="test-key",
        )
    )
    assert result["latex"] == "2x+4=0"
    assert calls == [DEFAULT_FORMULA_MODEL]


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
