from fastapi.testclient import TestClient

from local_board.main import create_app


def test_image_asset_upload_and_fetch(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        payload = b"fake-png-bytes"
        response = client.post(
            f"/api/boards/{room_id}/assets",
            content=payload,
            headers={"content-type": "image/png"},
        )
        assert response.status_code == 201
        src = response.json()["src"]
        fetched = client.get(src)
        assert fetched.status_code == 200
        assert fetched.content == payload


def test_rejects_unsupported_asset_type(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.post(
            f"/api/boards/{room_id}/assets",
            content=b"svg",
            headers={"content-type": "image/svg+xml"},
        )
        assert response.status_code == 415
