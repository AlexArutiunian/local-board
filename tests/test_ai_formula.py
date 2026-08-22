import os

import pytest
from fastapi.testclient import TestClient

from local_board.ai_formula import (
    DEFAULT_FORMULA_MODEL,
    FormulaRecognitionError,
    extract_latex,
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
    with pytest.raises(FormulaRecognitionError):
        validate_free_formula_model("google/gemini-3.1-flash-lite")


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
