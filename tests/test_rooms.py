from fastapi.testclient import TestClient

from local_board.main import create_app


def test_room_is_created_before_it_can_be_opened(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        missing = client.get("/b/9999")
        assert missing.status_code == 404

        response = client.post("/api/rooms")
        assert response.status_code == 201
        payload = response.json()
        room_id = payload["room_id"]

        assert len(room_id) == 4
        assert room_id.isdigit()
        assert payload["path"] == f"/b/{room_id}"
        assert client.get(payload["path"]).status_code == 200
        snapshot = client.get(f"/api/boards/{room_id}")
        assert snapshot.status_code == 200
        assert snapshot.json()["board_id"] == room_id
        assert snapshot.json()["objects"] == []

        listed = client.get("/api/rooms")
        assert listed.status_code == 200
        assert listed.json()["rooms"][0]["room_id"] == room_id


def test_created_room_ids_are_unique(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        first = client.post("/api/rooms").json()["room_id"]
        second = client.post("/api/rooms").json()["room_id"]
        assert first != second
        assert len(first) == len(second) == 4
        assert first.isdigit() and second.isdigit()
