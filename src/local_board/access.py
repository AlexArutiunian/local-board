from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import secrets
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import qrcode

PASSCODE_DIGITS = 6
PASSCODE_ITERATIONS = 260_000
INVITE_BYTES = 24
MAX_ACTIVE_INVITES_PER_ROLE = 8
DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60


def now_ms() -> int:
    return int(time.time() * 1000)


def generate_passcode() -> str:
    return f"{secrets.randbelow(10 ** PASSCODE_DIGITS):0{PASSCODE_DIGITS}d}"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    raw = value.encode("ascii")
    raw += b"=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw)


def hash_passcode(passcode: str, *, salt: bytes | None = None) -> str:
    normalized = str(passcode).strip()
    if not normalized.isdigit() or len(normalized) != PASSCODE_DIGITS:
        raise ValueError(f"passcode must contain exactly {PASSCODE_DIGITS} digits")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", normalized.encode("utf-8"), salt, PASSCODE_ITERATIONS)
    return f"pbkdf2_sha256${PASSCODE_ITERATIONS}${_b64url_encode(salt)}${_b64url_encode(digest)}"


def verify_passcode_hash(passcode: str, encoded: str) -> bool:
    try:
        algorithm, iterations_raw, salt_raw, digest_raw = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_raw)
        salt = _b64url_decode(salt_raw)
        expected = _b64url_decode(digest_raw)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            str(passcode).strip().encode("utf-8"),
            salt,
            iterations,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


class RoomAccessStore:
    """Atomic per-room access metadata. Only credential hashes are persisted."""

    def __init__(self, data_dir: Path):
        self.dir = data_dir / "access"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, board_id: str) -> Path:
        if not board_id or any(ch not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-" for ch in board_id):
            raise ValueError("invalid board id")
        return self.dir / f"{board_id}.json"

    def create(self, board_id: str, passcode: str) -> None:
        payload = {
            "version": 1,
            "board_id": board_id,
            "passcode_hash": hash_passcode(passcode),
            "invites": [],
            "created_at_ms": now_ms(),
            "updated_at_ms": now_ms(),
        }
        path = self._path(board_id)
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            with path.open("x", encoding="utf-8") as file:
                file.write(encoded)

    def exists(self, board_id: str) -> bool:
        return self._path(board_id).is_file()

    def _load(self, board_id: str) -> dict[str, Any]:
        path = self._path(board_id)
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or payload.get("board_id") != board_id:
            raise RuntimeError("invalid room access metadata")
        payload.setdefault("invites", [])
        return payload

    def _save(self, board_id: str, payload: dict[str, Any]) -> None:
        path = self._path(board_id)
        tmp = path.with_suffix(".json.tmp")
        payload["updated_at_ms"] = now_ms()
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        tmp.write_text(encoded, encoding="utf-8")
        tmp.replace(path)

    def verify_passcode(self, board_id: str, passcode: str) -> bool:
        try:
            payload = self._load(board_id)
        except (FileNotFoundError, json.JSONDecodeError, RuntimeError, ValueError):
            return False
        return verify_passcode_hash(passcode, str(payload.get("passcode_hash") or ""))

    def rotate_passcode(self, board_id: str, passcode: str) -> None:
        with self._lock:
            payload = self._load(board_id)
            payload["passcode_hash"] = hash_passcode(passcode)
            self._save(board_id, payload)

    def create_invite(
        self,
        board_id: str,
        role: str,
        *,
        ttl_seconds: int = DEFAULT_INVITE_TTL_SECONDS,
    ) -> tuple[str, int]:
        if role not in {"teacher", "student"}:
            raise ValueError("invalid invite role")
        token = _b64url_encode(secrets.token_bytes(INVITE_BYTES))
        expires_at_ms = now_ms() + max(300, int(ttl_seconds)) * 1000
        record = {
            "role": role,
            "token_hash": hash_invite_token(token),
            "created_at_ms": now_ms(),
            "expires_at_ms": expires_at_ms,
        }
        with self._lock:
            payload = self._load(board_id)
            current = now_ms()
            invites = [
                item for item in payload.get("invites", [])
                if isinstance(item, dict) and int(item.get("expires_at_ms", 0)) > current
            ]
            same_role = [item for item in invites if item.get("role") == role]
            other_role = [item for item in invites if item.get("role") != role]
            same_role = same_role[-(MAX_ACTIVE_INVITES_PER_ROLE - 1):] + [record]
            payload["invites"] = other_role + same_role
            self._save(board_id, payload)
        return token, expires_at_ms

    def redeem_invite(self, board_id: str, token: str) -> str | None:
        token_hash = hash_invite_token(token)
        try:
            payload = self._load(board_id)
        except (FileNotFoundError, json.JSONDecodeError, RuntimeError, ValueError):
            return None
        current = now_ms()
        for item in payload.get("invites", []):
            if not isinstance(item, dict):
                continue
            if int(item.get("expires_at_ms", 0)) <= current:
                continue
            if hmac.compare_digest(str(item.get("token_hash") or ""), token_hash):
                role = str(item.get("role") or "")
                return role if role in {"teacher", "student"} else None
        return None


class SessionSigner:
    """HMAC-signed, expiry-bound room session token."""

    def __init__(self, secret_key: str):
        secret = str(secret_key).encode("utf-8")
        if len(secret) < 32:
            raise ValueError("LOCAL_BOARD_SECRET_KEY must contain at least 32 bytes")
        self.secret = secret

    def issue(self, board_id: str, role: str, *, ttl_seconds: int = SESSION_TTL_SECONDS) -> str:
        if role not in {"teacher", "student"}:
            raise ValueError("invalid role")
        payload = {
            "v": 1,
            "board_id": board_id,
            "role": role,
            "iat": int(time.time()),
            "exp": int(time.time()) + max(300, int(ttl_seconds)),
            "nonce": _b64url_encode(secrets.token_bytes(8)),
        }
        encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        signature = _b64url_encode(hmac.new(self.secret, encoded.encode("ascii"), hashlib.sha256).digest())
        return f"{encoded}.{signature}"

    def verify(self, token: str | None, board_id: str) -> dict[str, Any] | None:
        if not token:
            return None
        try:
            encoded, signature = token.split(".", 1)
            expected = _b64url_encode(hmac.new(self.secret, encoded.encode("ascii"), hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                return None
            payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
            if payload.get("board_id") != board_id:
                return None
            if payload.get("role") not in {"teacher", "student"}:
                return None
            if int(payload.get("exp", 0)) <= int(time.time()):
                return None
            return payload
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
            return None


class LoginLimiter:
    """Single-process brute-force protection for room passcodes."""

    def __init__(self, *, max_attempts: int = 6, window_seconds: int = 60, block_seconds: int = 300):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.block_seconds = block_seconds
        self._attempts: dict[str, deque[float]] = defaultdict(deque)
        self._blocked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> int:
        now = time.monotonic()
        with self._lock:
            blocked_until = self._blocked_until.get(key, 0.0)
            if blocked_until > now:
                return max(1, int(blocked_until - now))
            attempts = self._attempts[key]
            cutoff = now - self.window_seconds
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
            return 0

    def fail(self, key: str) -> int:
        now = time.monotonic()
        with self._lock:
            attempts = self._attempts[key]
            cutoff = now - self.window_seconds
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
            attempts.append(now)
            if len(attempts) >= self.max_attempts:
                self._blocked_until[key] = now + self.block_seconds
                attempts.clear()
                return self.block_seconds
            return 0

    def success(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)
            self._blocked_until.pop(key, None)


def make_qr_data_url(value: str) -> str:
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=3)
    qr.add_data(value)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
