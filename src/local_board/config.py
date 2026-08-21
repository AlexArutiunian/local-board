from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def default_data_dir() -> Path:
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home).expanduser() / "local-board"
    return Path.home() / ".local" / "share" / "local-board"


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("LOCAL_BOARD_HOST", "0.0.0.0")
    port: int = int(os.environ.get("LOCAL_BOARD_PORT", "8000"))
    data_dir: Path = Path(
        os.environ.get("LOCAL_BOARD_DATA_DIR", str(default_data_dir()))
    ).expanduser()


SETTINGS = Settings()
WEB_DIR = Path(__file__).resolve().parent / "web"
