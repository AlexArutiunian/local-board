from fastapi.testclient import TestClient

from local_board.main import create_app


def test_formula_endpoint_can_use_local_ai_without_openrouter_key(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_BOARD_AI_PROVIDER", "local")
    monkeypatch.setenv("LOCAL_AI_BASE_URL", "http://127.0.0.1:8787/v1")
    monkeypatch.setenv("LOCAL_AI_MODEL", "local")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    async def fake_local(image, *, base_url, model, api_key):
        assert image.startswith("data:image/png;base64,")
        assert base_url == "http://127.0.0.1:8787/v1"
        assert model == "local"
        assert api_key == "local"
        return {"latex": "x^2+1", "model": model, "provider": "local"}

    monkeypatch.setattr("local_board.main.recognize_formula_local", fake_local)
    app = create_app(tmp_path)

    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.post(
            f"/api/boards/{room_id}/ai/formula",
            json={"image": "data:image/png;base64,iVBORw0KGgo="},
        )

    assert response.status_code == 200
    assert response.json()["latex"] == "x^2+1"
    assert response.json()["provider"] == "local"
