from __future__ import annotations

import asyncio
import hmac
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .access import (
    DEFAULT_INVITE_TTL_SECONDS,
    SESSION_TTL_SECONDS,
    LoginLimiter,
    RoomAccessStore,
    SessionSigner,
    generate_passcode,
    make_qr_data_url,
)
from .ai_formula import (
    DEFAULT_FORMULA_MODEL,
    FormulaNotFoundError,
    FormulaProviderUnavailableError,
    FormulaRecognitionError,
    recognize_formula,
    validate_formula_image_data_url,
)
from .config import SETTINGS, WEB_DIR
from .external import ExternalMirror
from .pdf_export import build_board_pdf
from .protocol import ProtocolError, normalize_client_event, normalize_participant_profile
from .room import RoomManager
from .room_service import RoomService
from .storage import ASSET_EXTENSIONS, JsonBoardStore, validate_board_id

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_AI_REQUEST_BYTES = 6_200_000
SESSION_COOKIE_PREFIX = "lb_session_"
ADMIN_COOKIE_NAME = "lb_admin"
ADMIN_SESSION_ID = "__local_board_admin__"


def create_app(data_dir: Path | None = None, *, require_admin: bool | None = None) -> FastAPI:
    if data_dir is None:
        SETTINGS.validate()
    admin_required = (data_dir is None) if require_admin is None else bool(require_admin)
    external = None if data_dir is not None else ExternalMirror.from_env()
    store = JsonBoardStore(data_dir or SETTINGS.data_dir, external_mirror=external)
    access = RoomAccessStore(data_dir or SETTINGS.data_dir)
    signer = SessionSigner(SETTINGS.secret_key)
    room_limiter = LoginLimiter()
    admin_limiter = LoginLimiter(max_attempts=6, window_seconds=60, block_seconds=300)
    rooms = RoomManager(store)
    room_service = RoomService(store)

    app = FastAPI(title="Local Board", version="0.7.0")
    if SETTINGS.allowed_hosts != ("*",):
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(SETTINGS.allowed_hosts))

    app.state.store = store
    app.state.access = access
    app.state.signer = signer
    app.state.rooms = rooms
    app.state.room_service = room_service
    app.state.external = external
    app.state.admin_required = admin_required

    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "font-src 'self' data: https://cdn.jsdelivr.net; "
            "connect-src 'self' ws: wss:; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        )
        forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
        if request.url.scheme == "https" or forwarded_proto == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

    @app.get("/health")
    async def health() -> dict[str, object]:
        mirrors = external.status() if external is not None else {"turso": False, "huggingface": False}
        return {"status": "ok", "mirrors": mirrors}

    @app.get("/")
    async def home() -> FileResponse:
        return FileResponse(WEB_DIR / "home.html")

    @app.get("/api/admin/session")
    async def admin_session(request: Request) -> dict[str, bool]:
        return {
            "required": admin_required,
            "authenticated": (not admin_required) or _is_admin(request, signer),
        }

    @app.post("/api/admin/login")
    async def admin_login(request: Request) -> Response:
        if not admin_required:
            return JSONResponse({"ok": True})
        key = f"admin:{_client_ip(request)}"
        retry_after = admin_limiter.check(key)
        if retry_after:
            raise HTTPException(
                status_code=429,
                detail="too many attempts",
                headers={"Retry-After": str(retry_after)},
            )
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid JSON") from exc
        password = str(payload.get("password") if isinstance(payload, dict) else "")
        if not hmac.compare_digest(password.encode("utf-8"), SETTINGS.admin_password.encode("utf-8")):
            admin_limiter.fail(key)
            raise HTTPException(status_code=401, detail="invalid teacher password")
        admin_limiter.success(key)
        response = JSONResponse({"ok": True})
        _set_admin_cookie(response, signer)
        return response

    @app.post("/api/admin/logout")
    async def admin_logout() -> Response:
        response = JSONResponse({"ok": True})
        response.delete_cookie(ADMIN_COOKIE_NAME, path="/")
        return response

    @app.get("/api/rooms")
    async def list_rooms(request: Request) -> dict[str, list[dict]]:
        boards = store.list_boards()
        if not admin_required or _is_admin(request, signer):
            return {"rooms": boards}
        visible = []
        for room in boards:
            board_id = str(room.get("room_id") or "")
            claims = signer.verify(request.cookies.get(_session_cookie_name(board_id)), board_id)
            if claims and claims.get("role") == "teacher":
                visible.append(room)
        return {"rooms": visible}

    @app.post("/api/rooms", status_code=201)
    async def create_room(request: Request) -> Response:
        if admin_required and not _is_admin(request, signer):
            raise HTTPException(status_code=401, detail="teacher login required")
        room_id = room_service.create_room()
        passcode = generate_passcode()
        access.create(room_id, passcode)
        response = JSONResponse(
            status_code=201,
            content={"room_id": room_id, "path": f"/b/{room_id}", "passcode": passcode},
        )
        _set_session_cookie(response, signer, room_id, "teacher")
        return response

    @app.get("/b/{board_id}")
    async def board_page(request: Request, board_id: str) -> Response:
        _require_existing_board(store, board_id)
        invite = request.query_params.get("invite", "").strip()
        if invite:
            role = access.redeem_invite(board_id, invite)
            if role is None:
                return RedirectResponse(url=f"/?room={board_id}&auth=invalid", status_code=303)
            response = RedirectResponse(url=f"/b/{board_id}", status_code=303)
            _set_session_cookie(response, signer, board_id, role)
            return response

        if _session_claims(request, signer, board_id) is None:
            return RedirectResponse(url=f"/?room={board_id}", status_code=303)
        return FileResponse(WEB_DIR / "index.html")

    @app.post("/api/boards/{board_id}/auth/passcode")
    async def login_with_passcode(request: Request, board_id: str) -> Response:
        _require_existing_board(store, board_id)
        if not access.exists(board_id):
            raise HTTPException(status_code=403, detail="room access is not initialized")
        key = f"room:{board_id}:{_client_ip(request)}"
        retry_after = room_limiter.check(key)
        if retry_after:
            raise HTTPException(
                status_code=429,
                detail="too many attempts",
                headers={"Retry-After": str(retry_after)},
            )
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid JSON") from exc
        passcode = str(payload.get("passcode") if isinstance(payload, dict) else "").strip()
        if not access.verify_passcode(board_id, passcode):
            room_limiter.fail(key)
            raise HTTPException(status_code=401, detail="invalid room code or passcode")
        room_limiter.success(key)
        existing = _session_claims(request, signer, board_id)
        role = "teacher" if existing and existing.get("role") == "teacher" else "student"
        response = JSONResponse({"ok": True, "path": f"/b/{board_id}", "role": role})
        _set_session_cookie(response, signer, board_id, role)
        return response

    @app.get("/api/boards/{board_id}/session")
    async def board_session(request: Request, board_id: str) -> dict[str, str]:
        _require_existing_board(store, board_id)
        claims = _require_session(request, signer, board_id)
        return {"board_id": board_id, "role": str(claims["role"])}

    @app.post("/api/boards/{board_id}/invites")
    async def create_invite(request: Request, board_id: str) -> dict[str, object]:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id, role="teacher")
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid JSON") from exc
        role = str(payload.get("role") if isinstance(payload, dict) else "student")
        if role not in {"teacher", "student"}:
            raise HTTPException(status_code=400, detail="invalid invite role")
        default_ttl = 15 * 60 if role == "teacher" else DEFAULT_INVITE_TTL_SECONDS
        ttl = int(payload.get("ttl_seconds", default_ttl)) if isinstance(payload, dict) else default_ttl
        ttl = max(300, min(ttl, 30 * 24 * 60 * 60))
        token, expires_at_ms = access.create_invite(board_id, role, ttl_seconds=ttl)
        base = _public_base_url(request)
        url = f"{base}/b/{board_id}?invite={token}"
        return {
            "url": url,
            "role": role,
            "expires_at_ms": expires_at_ms,
            "qr_data_url": make_qr_data_url(url),
        }

    @app.post("/api/boards/{board_id}/passcode/rotate")
    async def rotate_room_passcode(request: Request, board_id: str) -> dict[str, str]:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id, role="teacher")
        passcode = generate_passcode()
        access.rotate_passcode(board_id, passcode)
        return {"passcode": passcode}

    @app.get("/api/boards/{board_id}")
    async def board_snapshot(request: Request, board_id: str) -> dict:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id)
        room = await rooms.get(board_id)
        return room.snapshot_document()

    @app.get("/api/boards/{board_id}/export.pdf")
    async def export_board_pdf(request: Request, board_id: str) -> Response:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id)
        room = await rooms.get(board_id)
        document = room.snapshot_document()
        try:
            data = await asyncio.to_thread(
                build_board_pdf,
                board_id,
                document,
                asset_path=lambda asset_name: store.asset_path(board_id, asset_name),
            )
            await asyncio.to_thread(store.archive_pdf, board_id, data)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="failed to export board PDF") from exc
        return Response(
            content=data,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="Studybruh-{board_id}.pdf"',
                "Cache-Control": "no-store",
            },
        )

    @app.post("/api/boards/{board_id}/assets", status_code=201)
    async def upload_board_asset(request: Request, board_id: str) -> dict[str, str]:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id)
        content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type not in ASSET_EXTENSIONS:
            raise HTTPException(status_code=415, detail="unsupported image type")
        raw_length = request.headers.get("content-length")
        if raw_length and raw_length.isdigit() and int(raw_length) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="image is too large")
        data = await request.body()
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="image is too large")
        asset_name = await asyncio.to_thread(store.save_asset, board_id, content_type, data)
        return {
            "src": f"/api/boards/{board_id}/assets/{asset_name}",
            "name": asset_name,
        }

    @app.post("/api/boards/{board_id}/ai/formula")
    async def recognize_board_formula(request: Request, board_id: str) -> dict:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id)
        raw_length = request.headers.get("content-length")
        if raw_length and raw_length.isdigit() and int(raw_length) > MAX_AI_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="formula capture is too large")
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="invalid request")
        try:
            image = validate_formula_image_data_url(payload.get("image"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY is not configured")
        model = os.getenv("OPENROUTER_FORMULA_MODEL", DEFAULT_FORMULA_MODEL).strip() or DEFAULT_FORMULA_MODEL
        try:
            return await recognize_formula(image, api_key=api_key, model=model)
        except FormulaNotFoundError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except FormulaProviderUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except FormulaRecognitionError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.get("/api/boards/{board_id}/assets/{asset_name}")
    async def board_asset(request: Request, board_id: str, asset_name: str) -> FileResponse:
        _require_existing_board(store, board_id)
        _require_session(request, signer, board_id)
        try:
            path = store.asset_path(board_id, asset_name)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="asset not found") from exc
        if not path.is_file():
            raise HTTPException(status_code=404, detail="asset not found")
        return FileResponse(path, headers={"Cache-Control": "private, max-age=31536000, immutable"})

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
        claims = signer.verify(websocket.cookies.get(_session_cookie_name(board_id)), board_id)
        if claims is None:
            await websocket.close(code=1008, reason="room authentication required")
            return

        client_id = websocket.query_params.get("client_id") or str(uuid.uuid4())
        if len(client_id) > 128:
            await websocket.close(code=1008, reason="invalid client id")
            return
        try:
            profile = normalize_participant_profile(
                websocket.query_params.get("name") or "Участник",
                str(claims["role"]),
                websocket.query_params.get("device") or "Браузер",
            )
        except ProtocolError:
            await websocket.close(code=1008, reason="invalid participant profile")
            return

        room = await rooms.get(board_id)
        await websocket.accept()
        await room.connect(client_id, websocket, profile)

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


def _session_cookie_name(board_id: str) -> str:
    return f"{SESSION_COOKIE_PREFIX}{board_id}"


def _set_session_cookie(response: Response, signer: SessionSigner, board_id: str, role: str) -> None:
    response.set_cookie(
        key=_session_cookie_name(board_id),
        value=signer.issue(board_id, role),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=SETTINGS.production,
        samesite="lax",
        path="/",
    )


def _set_admin_cookie(response: Response, signer: SessionSigner) -> None:
    response.set_cookie(
        key=ADMIN_COOKIE_NAME,
        value=signer.issue(ADMIN_SESSION_ID, "teacher", ttl_seconds=SESSION_TTL_SECONDS),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=SETTINGS.production,
        samesite="strict",
        path="/",
    )


def _is_admin(request: Request, signer: SessionSigner) -> bool:
    claims = signer.verify(request.cookies.get(ADMIN_COOKIE_NAME), ADMIN_SESSION_ID)
    return bool(claims and claims.get("role") == "teacher")


def _session_claims(request: Request, signer: SessionSigner, board_id: str):
    return signer.verify(request.cookies.get(_session_cookie_name(board_id)), board_id)


def _require_session(request: Request, signer: SessionSigner, board_id: str, role: str | None = None):
    claims = _session_claims(request, signer, board_id)
    if claims is None:
        raise HTTPException(status_code=401, detail="room authentication required")
    if role is not None and claims.get("role") != role:
        raise HTTPException(status_code=403, detail="teacher access required")
    return claims


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


def _public_base_url(request: Request) -> str:
    if SETTINGS.public_base_url:
        return SETTINGS.public_base_url
    return str(request.base_url).rstrip("/")


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
        proxy_headers=True,
        forwarded_allow_ips="*" if SETTINGS.production else "127.0.0.1",
    )


if __name__ == "__main__":
    run()
