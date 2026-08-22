from fastapi.testclient import TestClient

from local_board.main import create_app


def receive_type(socket, expected_type, *, op_id=None):
    for _ in range(16):
        message = socket.receive_json()
        if message.get("type") != expected_type:
            continue
        if op_id is not None and message.get("op_id") != op_id:
            continue
        return message
    raise AssertionError(f"did not receive {expected_type!r}")


def test_image_delete_then_restore_same_id_is_broadcast_and_persisted(tmp_path):
    app = create_app(tmp_path)

    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        socket_path = f"/ws/{room_id}"
        image = {
            "id": "photo-undo",
            "kind": "image",
            "x": 30,
            "y": 40,
            "width": 320,
            "height": 180,
            "src": f"/api/boards/{room_id}/assets/{'a' * 32}.png",
            "name": "task.png",
            "crop_x": 0.1,
            "crop_y": 0.2,
            "crop_width": 0.7,
            "crop_height": 0.6,
        }

        with client.websocket_connect(f"{socket_path}?client_id=a") as a:
            receive_type(a, "snapshot")
            with client.websocket_connect(f"{socket_path}?client_id=b") as b:
                receive_type(b, "snapshot")
                receive_type(a, "presence")

                a.send_json({"type": "object.create", "op_id": "create", "object": image})
                receive_type(a, "ack", op_id="create")
                assert receive_type(b, "event")["event"]["type"] == "object.create"

                a.send_json({"type": "object.delete", "op_id": "delete", "object_id": image["id"]})
                receive_type(a, "ack", op_id="delete")
                assert receive_type(b, "event")["event"]["type"] == "object.delete"

                # Undo uses object.create with the original id and metadata.
                a.send_json({"type": "object.create", "op_id": "restore", "object": image})
                receive_type(a, "ack", op_id="restore")
                restored = receive_type(b, "event")["event"]
                assert restored["type"] == "object.create"
                assert restored["object"]["id"] == image["id"]
                assert restored["object"]["crop_width"] == 0.7

        with client.websocket_connect(f"{socket_path}?client_id=c") as c:
            snapshot = receive_type(c, "snapshot")["board"]
            assert len(snapshot["objects"]) == 1
            restored = snapshot["objects"][0]
            assert restored["id"] == image["id"]
            assert restored["x"] == 30.0
            assert restored["crop_y"] == 0.2
