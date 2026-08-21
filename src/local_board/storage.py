from __future__ import annotations

import json
import re
from pathlib import Path
from threading import Lock
from typing import Any

BOARD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def validate_board_id(board_id: str) -> str:
    if not BOARD_ID_RE.fullmatch(board_id):
        raise ValueError("board id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}")
    return board_id


def empty_board_document(board_id: str) -> dict[str, Any]:
    return {"version": 1, "board_id": board_id, "revision": 0, "strokes": []}


class JsonBoardStore:
    """Atomic JSON persistence for a single-host board server."""

    def __init__(self, data_dir: Path):
        self.boards_dir = data_dir / "boards"
        self.boards_dir.mkdir(parents=True, exist_ok=True)
        self._write_lock = Lock()

    def _path(self, board_id: str) -> Path:
        return self.boards_dir / f"{validate_board_id(board_id)}.json"

    def exists(self, board_id: str) -> bool:
        return self._path(board_id).is_file()

    def create(self, board_id: str) -> bool:
        """Create an empty room exactly once; return False on id collision."""
        path = self._path(board_id)
        encoded = json.dumps(
            empty_board_document(board_id),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with self._write_lock:
            try:
                with path.open("x", encoding="utf-8") as file:
                    file.write(encoded)
            except FileExistsError:
                return False
        return True

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
        return payload

    def save(self, board_id: str, document: dict[str, Any]) -> None:
        path = self._path(board_id)
        tmp = path.with_suffix(".json.tmp")
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            tmp.write_text(encoded, encoding="utf-8")
            tmp.replace(path)
