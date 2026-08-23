from fastapi.testclient import TestClient

from local_board.main import create_app
from local_board.pdf_export import board_content_bounds, build_board_pdf


def test_board_content_bounds_include_strokes_and_images():
    document = {
        "strokes": [
            {
                "id": "s1",
                "width": 8,
                "points": [{"x": 100, "y": 200}, {"x": 220, "y": 260}],
            }
        ],
        "objects": [
            {"id": "o1", "kind": "image", "x": -40, "y": 50, "width": 80, "height": 90}
        ],
    }
    bounds = board_content_bounds(document)
    assert bounds["x"] < -40
    assert bounds["y"] < 50
    assert bounds["x"] + bounds["width"] > 220
    assert bounds["y"] + bounds["height"] > 260


def test_build_board_pdf_returns_real_pdf(tmp_path):
    document = {
        "background": {"pattern": "grid", "tone": "warm"},
        "strokes": [
            {
                "id": "s1",
                "color": "#2563eb",
                "width": 4,
                "pointer_type": "pen",
                "points": [
                    {"x": 20, "y": 20, "pressure": 0.5},
                    {"x": 150, "y": 90, "pressure": 0.6},
                    {"x": 260, "y": 60, "pressure": 0.5},
                ],
            }
        ],
        "objects": [],
    }
    data = build_board_pdf("1234", document, asset_path=lambda name: tmp_path / name)
    assert data.startswith(b"%PDF-")
    assert len(data) > 1000


def test_pdf_export_endpoint_downloads_current_board(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        room_id = client.post("/api/rooms").json()["room_id"]
        response = client.get(f"/api/boards/{room_id}/export.pdf")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert f"Studybruh-{room_id}.pdf" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF-")
