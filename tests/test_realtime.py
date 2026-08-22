from fastapi.testclient import TestClient

from local_board.main import create_app


def receive_type(socket, expected_type, *, op_id=None):
    for _ in range(12):
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
            assert receive_type(a, "snapshot")["board"]["strokes"] == []

            with client.websocket_connect(f"{socket_path}?client_id=b") as b:
                receive_type(b, "snapshot")
                receive_type(a, "presence")

                a.send_json(begin)
                assert receive_type(a, "ack", op_id="op-begin")["revision"] == 1
                remote_begin = receive_type(b, "event")
                assert remote_begin["event"]["type"] == "stroke.begin"

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
