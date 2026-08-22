from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import SETTINGS, WEB_DIR
from .protocol import ProtocolError, normalize_client_event
from .room import RoomManager
from .room_service import RoomService
from .storage import ASSET_EXTENSIONS, JsonBoardStore, validate_board_id

MAX_IMAGE_BYTES = 12 * 1024 * 1024


def create_app(data_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="Local Board", version="0.4.0")
    store = JsonBoardStore(data_dir or SETTINGS.data_dir)
    rooms = RoomManager(store)
    room_service = RoomService(store)
    app.state.store = store
    app.state.rooms = rooms
    app.state.room_service = room_service

    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/")
    async def home() -> FileResponse:
        return FileResponse(WEB_DIR / "home.html")

    @app.get("/api/rooms")
    async def list_rooms() -> dict[str, list[dict]]:
        return {"rooms": store.list_boards()}

    @app.post("/api/rooms", status_code=201)
    async def create_room() -> dict[str, str]:
        room_id = room_service.create_room()
        return {"room_id": room_id, "path": f"/b/{room_id}"}

    @app.get("/b/{board_id}")
    async def board_page(board_id: str) -> FileResponse:
        _require_existing_board(store, board_id)
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/boards/{board_id}")
    async def board_snapshot(board_id: str) -> dict:
        _require_existing_board(store, board_id)
        room = await rooms.get(board_id)
        return room.snapshot_document()

    @app.post("/api/boards/{board_id}/assets", status_code=201)
    async def upload_board_asset(board_id: str, request: Request) -> dict[str, str]:
        _require_existing_board(store, board_id)
        content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type not in ASSET_EXTENSIONS:
            raise HTTPException(status_code=415, detail="unsupported image type")
        raw_length = request.headers.get("content-length")
        if raw_length and raw_length.isdigit() and int(raw_length) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="image is too large")
        data = await request.body()
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="image is too large")
        asset_name = store.save_asset(board_id, content_type, data)
        return {
            "src": f"/api/boards/{board_id}/assets/{asset_name}",
            "name": asset_name,
        }

    @app.get("/api/boards/{board_id}/assets/{asset_name}")
    async def board_asset(board_id: str, asset_name: str) -> FileResponse:
        _require_existing_board(store, board_id)
        try:
            path = store.asset_path(board_id, asset_name)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="asset not found") from exc
        if not path.is_file():
            raise HTTPException(status_code=404, detail="asset not found")
        return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.websocket("/ws/{board_id}")
    async def board_socket(websocket: WebSocket, board_id: str) -> None:
        try:
            validate_board_id(board_id)
        except ValueError:
            await websocket.close(code=1008, reason="invalid board id")
            return
        if not store.exists(board_id):
            await websocket.close(code=1008, reason="room does not exist")
            return

        client_id = websocket.query_params.get("client_id") or str(uuid.uuid4())
        if len(client_id) > 128:
            await websocket.close(code=1008, reason="invalid client id")
            return

        room = await rooms.get(board_id)
        await websocket.accept()
        await room.connect(client_id, websocket)

        try:
            while True:
                raw = await websocket.receive_json()
                try:
                    event = normalize_client_event(raw)
                    await room.handle_event(client_id, event)
                except ProtocolError as exc:
                    await websocket.send_json(
                        {
                            "type": "error",
                            "code": "invalid_event",
                            "message": str(exc),
                        }
                    )
        except WebSocketDisconnect:
            pass
        finally:
            await room.disconnect(client_id, websocket)

    return app


def _require_existing_board(store: JsonBoardStore, board_id: str) -> None:
    try:
        validate_board_id(board_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="invalid room id") from exc
    if not store.exists(board_id):
        raise HTTPException(status_code=404, detail="room not found")


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "local_board.main:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        reload=False,
    )


if __name__ == "__main__":
    run()
