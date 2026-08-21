import pytest

from local_board.protocol import ProtocolError, normalize_client_event


def test_normalizes_stroke_begin():
    event = normalize_client_event(
        {
            "type": "stroke.begin",
            "op_id": "op-1",
            "stroke": {
                "id": "stroke-1",
                "color": "#111111",
                "width": 4,
                "pointer_type": "pen",
                "points": [{"x": 1, "y": 2, "pressure": 0.8}],
            },
        }
    )
    assert event["stroke"]["id"] == "stroke-1"
    assert event["stroke"]["points"][0]["pressure"] == 0.8


def test_rejects_unknown_event():
    with pytest.raises(ProtocolError):
        normalize_client_event({"type": "destroy.everything", "op_id": "x"})


def test_rejects_invalid_color():
    with pytest.raises(ProtocolError):
        normalize_client_event(
            {
                "type": "stroke.begin",
                "op_id": "op-1",
                "stroke": {
                    "id": "stroke-1",
                    "color": "red",
                    "width": 4,
                    "points": [{"x": 1, "y": 2}],
                },
            }
        )


def test_restore_accepts_full_stroke_larger_than_network_batch():
    points = [{"x": i, "y": i, "pressure": 0.5} for i in range(300)]
    event = normalize_client_event(
        {
            "type": "stroke.restore",
            "op_id": "redo-1",
            "stroke": {
                "id": "long-stroke",
                "color": "#111111",
                "width": 4,
                "pointer_type": "pen",
                "points": points,
            },
        }
    )
    assert len(event["stroke"]["points"]) == 300
