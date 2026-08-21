from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import SETTINGS, WEB_DIR
from .protocol import ProtocolError, normalize_client_event
from .room import RoomManager
from .storage import JsonBoardStore, validate_board_id


def create_app(data_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="Local Board", version="0.2.0")
    store = JsonBoardStore(data_dir or SETTINGS.data_dir)
    rooms = RoomManager(store)
    app.state.store = store
    app.state.rooms = rooms

    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/b/{board_id}")
    async def board_page(board_id: str) -> FileResponse:
        try:
            validate_board_id(board_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="invalid board id") from exc
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/boards/{board_id}")
    async def board_snapshot(board_id: str) -> dict:
        try:
            validate_board_id(board_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="invalid board id") from exc
        room = await rooms.get(board_id)
        return room.snapshot_document()

    @app.websocket("/ws/{board_id}")
    async def board_socket(websocket: WebSocket, board_id: str) -> None:
        try:
            validate_board_id(board_id)
        except ValueError:
            await websocket.close(code=1008, reason="invalid board id")
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
