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


def test_two_clients_receive_live_stroke_and_new_client_gets_snapshot(tmp_path):
    app = create_app(tmp_path)
    begin = {
        "type": "stroke.begin",
        "op_id": "op-begin",
        "stroke": {
            "id": "stroke-1",
            "color": "#111111",
            "width": 4,
            "pointer_type": "pen",
            "source_zoom": 0.65,
            "points": [{"x": 10, "y": 20, "pressure": 0.7}],
        },
    }
    append = {
        "type": "stroke.append",
        "op_id": "op-append",
        "stroke_id": "stroke-1",
        "points": [{"x": 11, "y": 21, "pressure": 0.8}],
    }
    end = {"type": "stroke.end", "op_id": "op-end", "stroke_id": "stroke-1"}

    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        socket_path = f"/ws/{room_id}"

        with client.websocket_connect(f"{socket_path}?client_id=a") as a:
            first_snapshot = receive_type(a, "snapshot")["board"]
            assert first_snapshot["strokes"] == []
            assert first_snapshot["objects"] == []

            with client.websocket_connect(f"{socket_path}?client_id=b") as b:
                receive_type(b, "snapshot")
                receive_type(a, "presence")

                a.send_json(begin)
                assert receive_type(a, "ack", op_id="op-begin")["revision"] == 1
                remote_begin = receive_type(b, "event")
                assert remote_begin["event"]["type"] == "stroke.begin"
                assert remote_begin["event"]["stroke"]["source_zoom"] == 0.65

                a.send_json(append)
                receive_type(a, "ack", op_id="op-append")
                remote_append = receive_type(b, "event")
                assert remote_append["event"]["points"][0]["x"] == 11.0

                a.send_json(end)
                receive_type(a, "ack", op_id="op-end")
                assert receive_type(b, "event")["event"]["type"] == "stroke.end"

            with client.websocket_connect(f"{socket_path}?client_id=c") as c:
                snapshot = receive_type(c, "snapshot")["board"]
                assert snapshot["revision"] == 3
                assert len(snapshot["strokes"]) == 1
                assert len(snapshot["strokes"][0]["points"]) == 2
                assert snapshot["strokes"][0]["complete"] is True
                assert snapshot["strokes"][0]["source_zoom"] == 0.65


def test_image_object_and_transforms_sync_and_survive_snapshot(tmp_path):
    app = create_app(tmp_path)

    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        socket_path = f"/ws/{room_id}"
        src = f"/api/boards/{room_id}/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"

        create_object = {
            "type": "object.create",
            "op_id": "object-create",
            "object": {
                "id": "img-1",
                "kind": "image",
                "x": 100,
                "y": 120,
                "width": 320,
                "height": 180,
                "src": src,
                "name": "task.png",
            },
        }
        update_object = {
            "type": "object.update",
            "op_id": "object-update",
            "object_id": "img-1",
            "patch": {"x": 160, "y": 170, "width": 400, "height": 225},
        }

        with client.websocket_connect(f"{socket_path}?client_id=a") as a:
            receive_type(a, "snapshot")
            with client.websocket_connect(f"{socket_path}?client_id=b") as b:
                receive_type(b, "snapshot")
                receive_type(a, "presence")

                a.send_json(create_object)
                receive_type(a, "ack", op_id="object-create")
                created_remote = receive_type(b, "event")["event"]
                assert created_remote["type"] == "object.create"
                assert created_remote["object"]["src"] == src

                a.send_json(update_object)
                receive_type(a, "ack", op_id="object-update")
                updated_remote = receive_type(b, "event")["event"]
                assert updated_remote["type"] == "object.update"
                assert updated_remote["patch"]["x"] == 160.0

            with client.websocket_connect(f"{socket_path}?client_id=c") as c:
                snapshot = receive_type(c, "snapshot")["board"]
                assert len(snapshot["objects"]) == 1
                image = snapshot["objects"][0]
                assert image["id"] == "img-1"
                assert image["x"] == 160.0
                assert image["width"] == 400.0


def test_stroke_translation_is_broadcast_and_persisted(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        socket_path = f"/ws/{room_id}"
        with client.websocket_connect(f"{socket_path}?client_id=a") as a:
            receive_type(a, "snapshot")
            a.send_json(
                {
                    "type": "stroke.begin",
                    "op_id": "begin",
                    "stroke": {
                        "id": "s1",
                        "color": "#111111",
                        "width": 4,
                        "pointer_type": "pen",
                        "points": [{"x": 5, "y": 6, "pressure": 0.5}],
                    },
                }
            )
            receive_type(a, "ack", op_id="begin")
            a.send_json({"type": "stroke.end", "op_id": "end", "stroke_id": "s1"})
            receive_type(a, "ack", op_id="end")
            a.send_json(
                {
                    "type": "stroke.translate",
                    "op_id": "move",
                    "stroke_id": "s1",
                    "dx": 10,
                    "dy": -2,
                }
            )
            receive_type(a, "ack", op_id="move")

        with client.websocket_connect(f"{socket_path}?client_id=c") as c:
            snapshot = receive_type(c, "snapshot")["board"]
            point = snapshot["strokes"][0]["points"][0]
            assert point["x"] == 15.0
            assert point["y"] == 4.0
