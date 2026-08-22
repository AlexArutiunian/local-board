import os

import pytest
from fastapi.testclient import TestClient

from local_board.ai_formula import (
    DEFAULT_FORMULA_MODEL,
    MAX_OUTPUT_TOKENS,
    REQUEST_TIMEOUT_SECONDS,
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
    assert extract_latex(r"\(2x+4=0\)") == "2x+4=0"
    assert extract_json_latex('{"latex":"x^2-2x+1=0"}') == "x^2-2x+1=0"
    assert extract_json_latex("UserSafety: safe") == ""


def test_validate_formula_image_data_url():
    value = "data:image/png;base64,iVBORw0KGgo="
    assert validate_formula_image_data_url(value) == value


def test_formula_model_defaults_to_current_free_ox_alpha():
    assert DEFAULT_FORMULA_MODEL == "stealth/ox-alpha"
    assert validate_free_formula_model(DEFAULT_FORMULA_MODEL) == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model("qwen/qwen2.5-vl-32b-instruct:free") == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model("google/gemma-4-31b-it:free") == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model("openrouter/free") == DEFAULT_FORMULA_MODEL
    assert validate_free_formula_model("some/current-model:free") == "some/current-model:free"
    with pytest.raises(FormulaRecognitionError):
        validate_free_formula_model("google/gemini-3.1-flash-lite")


def test_formula_candidates_do_not_race_unrelated_models():
    assert formula_model_candidates(DEFAULT_FORMULA_MODEL) == [DEFAULT_FORMULA_MODEL]


def test_ox_transport_budget_does_not_cut_off_normal_slow_tail():
    # OpenRouter currently reports ~6.8s P50 for Ox Alpha. Keep the client
    # timeout comfortably above that so a healthy slow-tail request is not
    # misreported by our own backend as HTTP 503.
    assert REQUEST_TIMEOUT_SECONDS >= 20
    # Avoid the old tiny completion cap on a reasoning model. Visible formula
    # output remains short because the prompt asks for LaTeX only.
    assert MAX_OUTPUT_TOKENS >= 128


def test_no_formula_and_safety_output_detection():
    assert is_no_formula_response("__NO_FORMULA__")
    assert is_no_formula_response("no formula found")
    assert not is_no_formula_response(r"x^2+1=0")
    assert looks_like_non_formula_output("UserSafety: safe")
    assert looks_like_non_formula_output("unsafe category: something")
    assert not looks_like_non_formula_output(r"x^2-2x+1=0")


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
        raise FormulaProviderUnavailableError("Ox Alpha temporarily unavailable")

    monkeypatch.setattr("local_board.main.recognize_formula", unavailable)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.post(
            f"/api/boards/{room_id}/ai/formula",
            json={"image": "data:image/png;base64,iVBORw0KGgo="},
        )
    assert response.status_code == 503
