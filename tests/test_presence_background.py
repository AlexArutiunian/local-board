from fastapi.testclient import TestClient

from local_board.main import create_app


def receive_type(socket, expected_type):
    for _ in range(20):
        message = socket.receive_json()
        if message.get("type") == expected_type:
            return message
    raise AssertionError(f"did not receive {expected_type!r}")


def test_presence_roster_contains_roles_names_and_devices(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        path = f"/ws/{room_id}"
        with client.websocket_connect(
            f"{path}?client_id=teacher-ipad&name=Alex&role=teacher&device=iPad"
        ) as teacher:
            first = receive_type(teacher, "snapshot")
            assert first["roster"] == [
                {
                    "client_id": "teacher-ipad",
                    "name": "Alex",
                    "role": "teacher",
                    "device": "iPad",
                }
            ]
            with client.websocket_connect(
                f"{path}?client_id=student-pc&name=Masha&role=student&device=Computer"
            ) as student:
                snapshot = receive_type(student, "snapshot")
                assert [item["role"] for item in snapshot["roster"]] == ["teacher", "student"]
                presence = receive_type(teacher, "presence")
                assert presence["participants"] == 2
                assert {item["name"] for item in presence["roster"]} == {"Alex", "Masha"}


def test_background_event_broadcasts_and_survives_snapshot(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        path = f"/ws/{room_id}"
        with client.websocket_connect(f"{path}?client_id=a") as a:
            snapshot = receive_type(a, "snapshot")
            assert snapshot["board"]["background"] == {"pattern": "dots", "tone": "white"}
            with client.websocket_connect(f"{path}?client_id=b") as b:
                receive_type(b, "snapshot")
                receive_type(a, "presence")
                event = {
                    "type": "board.background",
                    "op_id": "paper-1",
                    "background": {"pattern": "cornell", "tone": "warm"},
                }
                a.send_json(event)
                receive_type(a, "ack")
                remote = receive_type(b, "event")
                assert remote["event"] == event

        with client.websocket_connect(f"{path}?client_id=c") as c:
            snapshot = receive_type(c, "snapshot")
            assert snapshot["board"]["background"] == {"pattern": "cornell", "tone": "warm"}
