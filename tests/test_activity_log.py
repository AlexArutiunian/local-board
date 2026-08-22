import json

from fastapi.testclient import TestClient

from local_board.main import create_app


def receive_type(socket, expected_type):
    for _ in range(30):
        message = socket.receive_json()
        if message.get("type") == expected_type:
            return message
    raise AssertionError(f"did not receive {expected_type!r}")


def read_activity(tmp_path, room_id):
    records = []
    for path in sorted((tmp_path / "activity" / room_id).glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
    return records


def test_activity_log_records_role_and_compacts_stroke_packets(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        path = f"/ws/{room_id}"

        with client.websocket_connect(
            f"{path}?client_id=teacher-ipad&name=Alex&role=teacher&device=iPad"
        ) as teacher:
            receive_type(teacher, "snapshot")
            teacher.send_json(
                {
                    "type": "stroke.begin",
                    "op_id": "begin-1",
                    "stroke": {
                        "id": "stroke-1",
                        "color": "#111111",
                        "width": 4,
                        "pointer_type": "pen",
                        "points": [{"x": 10, "y": 20, "pressure": 0.5}],
                    },
                }
            )
            receive_type(teacher, "ack")
            teacher.send_json(
                {
                    "type": "stroke.append",
                    "op_id": "append-1",
                    "stroke_id": "stroke-1",
                    "points": [
                        {"x": 14, "y": 26, "pressure": 0.6},
                        {"x": 19, "y": 18, "pressure": 0.7},
                    ],
                }
            )
            receive_type(teacher, "ack")
            teacher.send_json({"type": "stroke.end", "op_id": "end-1", "stroke_id": "stroke-1"})
            receive_type(teacher, "ack")

        with client.websocket_connect(
            f"{path}?client_id=student-pc&name=Masha&role=student&device=Computer"
        ) as student:
            receive_type(student, "snapshot")

    records = read_activity(tmp_path, room_id)
    kinds = [record["k"] for record in records]

    assert "stroke.begin" not in kinds
    assert "stroke.append" not in kinds
    assert "stroke" in kinds

    stroke = next(record for record in records if record["k"] == "stroke")
    assert stroke["actor"] == {
        "id": "teacher-ipad",
        "name": "Alex",
        "role": "teacher",
        "device": "iPad",
    }
    assert stroke["sid"] == "stroke-1"
    assert stroke["points"] == 3
    assert stroke["bbox"] == [10.0, 18.0, 19.0, 26.0]
    assert stroke["t0"] <= stroke["t"]
    assert stroke["ms"] >= 0

    student_join = next(
        record for record in records
        if record["k"] == "join" and record["actor"]["id"] == "student-pc"
    )
    assert student_join["actor"]["role"] == "student"
    assert any(record["k"] == "leave" and record["actor"]["role"] == "teacher" for record in records)
