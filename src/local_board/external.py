from __future__ import annotations

import gzip
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ExternalMirror:
    """Best-effort production mirror: Turso for structured data, HF Bucket for cold files."""

    def __init__(self, *, turso_url: str = "", turso_token: str = "", hf_bucket: str = "", hf_token: str = ""):
        self.turso_url = turso_url.strip()
        self.turso_token = turso_token.strip()
        self.hf_bucket = hf_bucket.strip()
        self.hf_token = hf_token.strip()
        self._hf_last_activity_upload: dict[str, float] = {}
        self._hf_lock = threading.Lock()
        if self.turso_enabled:
            self._init_turso_schema()

    @classmethod
    def from_env(cls) -> "ExternalMirror | None":
        mirror = cls(
            turso_url=os.getenv("TURSO_DATABASE_URL", ""),
            turso_token=os.getenv("TURSO_AUTH_TOKEN", ""),
            hf_bucket=os.getenv("HF_BUCKET_ID", ""),
            hf_token=os.getenv("HF_TOKEN", ""),
        )
        return mirror if mirror.turso_enabled or mirror.hf_enabled else None

    @property
    def turso_enabled(self) -> bool:
        return bool(self.turso_url and self.turso_token)

    @property
    def hf_enabled(self) -> bool:
        return bool(self.hf_bucket and self.hf_token)

    def status(self) -> dict[str, bool]:
        return {"turso": self.turso_enabled, "huggingface": self.hf_enabled}

    def _connect_turso(self):
        import libsql

        return libsql.connect(database=self.turso_url, auth_token=self.turso_token)

    def _init_turso_schema(self) -> None:
        conn = self._connect_turso()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS board_snapshots (
                    board_id TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS activity (
                    event_id TEXT PRIMARY KEY,
                    board_id TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    actor_id TEXT,
                    actor_name TEXT,
                    actor_role TEXT,
                    actor_device TEXT,
                    payload_json TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_board_time ON activity(board_id, timestamp_ms)")
            conn.commit()
        finally:
            conn.close()

    def mirror_snapshot(self, board_id: str, document: dict[str, Any]) -> None:
        if not self.turso_enabled:
            return
        try:
            conn = self._connect_turso()
            try:
                encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
                conn.execute(
                    """
                    INSERT INTO board_snapshots(board_id, revision, snapshot_json, updated_at_ms)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(board_id) DO UPDATE SET
                        revision=excluded.revision,
                        snapshot_json=excluded.snapshot_json,
                        updated_at_ms=excluded.updated_at_ms
                    """,
                    (board_id, int(document.get("revision", 0)), encoded, int(time.time() * 1000)),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception:
            logger.exception("Turso snapshot mirror failed for %s", board_id)

    def mirror_activity(self, board_id: str, record: dict[str, Any], local_path: Path | None = None) -> None:
        if self.turso_enabled:
            try:
                actor = record.get("actor") if isinstance(record.get("actor"), dict) else {}
                conn = self._connect_turso()
                try:
                    conn.execute(
                        """
                        INSERT INTO activity(
                            event_id, board_id, timestamp_ms, kind,
                            actor_id, actor_name, actor_role, actor_device, payload_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            uuid.uuid4().hex,
                            board_id,
                            int(record.get("t", 0)),
                            str(record.get("k") or "unknown"),
                            actor.get("id"),
                            actor.get("name"),
                            actor.get("role"),
                            actor.get("device"),
                            json.dumps(record, ensure_ascii=False, separators=(",", ":")),
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
            except Exception:
                logger.exception("Turso activity mirror failed for %s", board_id)

        if self.hf_enabled and local_path is not None:
            self._maybe_archive_activity_file(board_id, local_path)

    def mirror_asset(self, board_id: str, asset_name: str, data: bytes) -> None:
        if not self.hf_enabled:
            return
        self._hf_upload(data, f"assets/{board_id}/{asset_name}")

    def mirror_pdf(self, board_id: str, pdf_bytes: bytes) -> None:
        if not self.hf_enabled:
            return
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        self._hf_upload(pdf_bytes, f"exports/{board_id}/{stamp}.pdf")

    def _maybe_archive_activity_file(self, board_id: str, local_path: Path) -> None:
        key = str(local_path)
        now = time.monotonic()
        with self._hf_lock:
            if now - self._hf_last_activity_upload.get(key, 0.0) < 60.0:
                return
            self._hf_last_activity_upload[key] = now
        try:
            data = local_path.read_bytes()
            compressed = gzip.compress(data, compresslevel=6)
            remote = f"activity/{board_id}/{local_path.stem}.jsonl.gz"
            self._hf_upload(compressed, remote)
        except Exception:
            logger.exception("HF activity archive failed for %s", board_id)

    def _hf_upload(self, data: bytes, path: str) -> None:
        try:
            from huggingface_hub import batch_bucket_files

            batch_bucket_files(self.hf_bucket, add=[(data, path)], token=self.hf_token)
        except Exception:
            logger.exception("HF bucket upload failed: %s", path)
