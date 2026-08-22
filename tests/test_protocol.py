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
                "source_zoom": 0.65,
                "points": [{"x": 1, "y": 2, "pressure": 0.8}],
            },
        }
    )
    assert event["stroke"]["id"] == "stroke-1"
    assert event["stroke"]["points"][0]["pressure"] == 0.8
    assert event["stroke"]["source_zoom"] == 0.65


def test_clamps_source_zoom_metadata():
    event = normalize_client_event(
        {
            "type": "stroke.begin",
            "op_id": "op-zoom",
            "stroke": {
                "id": "stroke-zoom",
                "color": "#111111",
                "width": 4,
                "source_zoom": 99,
                "points": [{"x": 1, "y": 2}],
            },
        }
    )
    assert event["stroke"]["source_zoom"] == 5.0


def test_normalizes_image_object_and_update():
    created = normalize_client_event(
        {
            "type": "object.create",
            "op_id": "obj-create",
            "object": {
                "id": "img-1",
                "kind": "image",
                "x": 10,
                "y": 20,
                "width": 320,
                "height": 180,
                "src": "/api/boards/1234/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                "name": "task.png",
            },
        }
    )
    assert created["object"]["width"] == 320.0
    assert created["object"]["crop_x"] == 0.0
    assert created["object"]["crop_width"] == 1.0

    updated = normalize_client_event(
        {
            "type": "object.update",
            "op_id": "obj-move",
            "object_id": "img-1",
            "patch": {
                "x": 44,
                "y": 55,
                "width": 400,
                "height": 225,
                "crop_x": 0.1,
                "crop_y": 0.2,
                "crop_width": 0.7,
                "crop_height": 0.6,
            },
        }
    )
    assert updated["patch"]["x"] == 44.0
    assert updated["patch"]["crop_width"] == 0.7


def test_rejects_invalid_crop_values():
    with pytest.raises(ProtocolError):
        normalize_client_event(
            {
                "type": "object.update",
                "op_id": "bad-crop",
                "object_id": "img-1",
                "patch": {"crop_width": 1.5},
            }
        )


def test_normalizes_stroke_translation():
    event = normalize_client_event(
        {"type": "stroke.translate", "op_id": "move-1", "stroke_id": "s1", "dx": 12, "dy": -8}
    )
    assert event["dx"] == 12.0
    assert event["dy"] == -8.0


def test_rejects_external_image_src():
    with pytest.raises(ProtocolError):
        normalize_client_event(
            {
                "type": "object.create",
                "op_id": "bad-image",
                "object": {
                    "id": "img",
                    "kind": "image",
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 100,
                    "src": "https://example.com/image.png",
                },
            }
        )


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
