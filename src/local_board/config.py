from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEV_SECRET = "local-board-development-secret-change-me-2026"


def default_data_dir() -> Path:
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home).expanduser() / "local-board"
    return Path.home() / ".local" / "share" / "local-board"


def _allowed_hosts() -> tuple[str, ...]:
    raw = os.environ.get("LOCAL_BOARD_ALLOWED_HOSTS", "*")
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    return values or ("*",)


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("LOCAL_BOARD_HOST", "0.0.0.0")
    port: int = int(os.environ.get("PORT", os.environ.get("LOCAL_BOARD_PORT", "8000")))
    data_dir: Path = Path(
        os.environ.get("LOCAL_BOARD_DATA_DIR", str(default_data_dir()))
    ).expanduser()
    environment: str = os.environ.get("LOCAL_BOARD_ENV", "development").strip().lower()
    secret_key: str = os.environ.get("LOCAL_BOARD_SECRET_KEY", DEV_SECRET)
    allowed_hosts: tuple[str, ...] = _allowed_hosts()
    public_base_url: str = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")

    @property
    def production(self) -> bool:
        return self.environment == "production"

    def validate(self) -> None:
        if self.production and self.secret_key == DEV_SECRET:
            raise RuntimeError("LOCAL_BOARD_SECRET_KEY must be set in production")
        if len(self.secret_key.encode("utf-8")) < 32:
            raise RuntimeError("LOCAL_BOARD_SECRET_KEY must contain at least 32 bytes")


SETTINGS = Settings()
WEB_DIR = Path(__file__).resolve().parent / "web"
