from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

BOARD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
ASSET_NAME_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|webp|gif)$")
ASSET_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}


def validate_board_id(board_id: str) -> str:
    if not BOARD_ID_RE.fullmatch(board_id):
        raise ValueError("board id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}")
    return board_id


def empty_board_document(board_id: str) -> dict[str, Any]:
    return {"version": 1, "board_id": board_id, "revision": 0, "strokes": [], "objects": []}


class JsonBoardStore:
    """Atomic local persistence with optional best-effort production mirrors."""

    def __init__(self, data_dir: Path, external_mirror: Any = None):
        self.data_dir = data_dir
        self.boards_dir = data_dir / "boards"
        self.assets_dir = data_dir / "assets"
        self.activity_dir = data_dir / "activity"
        self.boards_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self.activity_dir.mkdir(parents=True, exist_ok=True)
        self.external_mirror = external_mirror
        self._write_lock = Lock()

    def _path(self, board_id: str) -> Path:
        return self.boards_dir / f"{validate_board_id(board_id)}.json"

    def exists(self, board_id: str) -> bool:
        return self._path(board_id).is_file()

    def create(self, board_id: str) -> bool:
        path = self._path(board_id)
        document = empty_board_document(board_id)
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            try:
                with path.open("x", encoding="utf-8") as file:
                    file.write(encoded)
            except FileExistsError:
                return False
        if self.external_mirror is not None:
            self.external_mirror.mirror_snapshot(board_id, document)
        return True

    def list_boards(self) -> list[dict[str, Any]]:
        boards: list[dict[str, Any]] = []
        for path in self.boards_dir.glob("*.json"):
            board_id = path.stem
            try:
                validate_board_id(board_id)
                stat = path.stat()
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError, json.JSONDecodeError):
                continue
            strokes = payload.get("strokes") if isinstance(payload, dict) else []
            objects = payload.get("objects") if isinstance(payload, dict) else []
            boards.append(
                {
                    "room_id": board_id,
                    "path": f"/b/{board_id}",
                    "revision": int(payload.get("revision", 0)) if isinstance(payload, dict) else 0,
                    "stroke_count": len(strokes) if isinstance(strokes, list) else 0,
                    "object_count": len(objects) if isinstance(objects, list) else 0,
                    "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                }
            )
        boards.sort(key=lambda item: item["updated_at"], reverse=True)
        return boards

    def load(self, board_id: str) -> dict[str, Any]:
        path = self._path(board_id)
        if not path.exists():
            return empty_board_document(board_id)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"failed to load board {board_id!r}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("strokes"), list):
            raise RuntimeError(f"invalid board document for {board_id!r}")
        if not isinstance(payload.get("objects", []), list):
            raise RuntimeError(f"invalid objects for board {board_id!r}")
        payload.setdefault("objects", [])
        return payload

    def save(self, board_id: str, document: dict[str, Any]) -> None:
        path = self._path(board_id)
        tmp = path.with_suffix(".json.tmp")
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            tmp.write_text(encoded, encoding="utf-8")
            tmp.replace(path)
        if self.external_mirror is not None:
            self.external_mirror.mirror_snapshot(board_id, document)

    def append_activity(self, board_id: str, record: dict[str, Any]) -> Path:
        """Append one compact semantic JSON line and mirror it to configured services."""
        validate_board_id(board_id)
        timestamp_ms = int(record.get("t", 0))
        if timestamp_ms <= 0:
            raise ValueError("activity record requires positive millisecond timestamp")
        day = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        room_dir = self.activity_dir / board_id
        path = room_dir / f"{day}.jsonl"
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            room_dir.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as file:
                file.write(encoded)
                file.write("\n")
        if self.external_mirror is not None:
            self.external_mirror.mirror_activity(board_id, record, path)
        return path

    def save_asset(self, board_id: str, content_type: str, data: bytes) -> str:
        validate_board_id(board_id)
        extension = ASSET_EXTENSIONS.get(content_type)
        if extension is None:
            raise ValueError("unsupported image type")
        room_dir = self.assets_dir / board_id
        room_dir.mkdir(parents=True, exist_ok=True)
        name = f"{secrets.token_hex(16)}.{extension}"
        path = room_dir / name
        with self._write_lock:
            path.write_bytes(data)
        if self.external_mirror is not None:
            self.external_mirror.mirror_asset(board_id, name, data)
        return name

    def asset_path(self, board_id: str, asset_name: str) -> Path:
        validate_board_id(board_id)
        if not ASSET_NAME_RE.fullmatch(asset_name):
            raise ValueError("invalid asset name")
        return self.assets_dir / board_id / asset_name

    def archive_pdf(self, board_id: str, pdf_bytes: bytes) -> None:
        validate_board_id(board_id)
        if self.external_mirror is not None:
            self.external_mirror.mirror_pdf(board_id, pdf_bytes)
