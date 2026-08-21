from __future__ import annotations

import json
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
BOARD_FILE = DATA / "board.json"
LOCK = Lock()

HOST = os.environ.get("WHITEBOARD_HOST", "0.0.0.0")
PORT = int(os.environ.get("WHITEBOARD_PORT", "8000"))

DEFAULT_BOARD = {
    "version": 1,
    "strokes": [],
    "view": {"x": 0, "y": 0, "zoom": 1},
}

DATA.mkdir(parents=True, exist_ok=True)


def load_board():
    with LOCK:
        if not BOARD_FILE.exists():
            return dict(DEFAULT_BOARD)
        try:
            return json.loads(BOARD_FILE.read_text(encoding="utf-8"))
        except Exception:
            return dict(DEFAULT_BOARD)


def save_board(data):
    with LOCK:
        tmp = BOARD_FILE.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        tmp.replace(BOARD_FILE)


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalBoard/1.0"

    def log_message(self, fmt, *args):
        print(f"[local-board] {self.address_string()} - {fmt % args}")

    def send_json(self, data, status=HTTPStatus.OK):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_file(self, path: Path):
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content = path.read_bytes()
        mime, _ = mimetypes.guess_type(path.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.send_header(
            "Cache-Control",
            "no-cache" if path.suffix in {".html", ".js", ".css"} else "public, max-age=3600",
        )
        self.end_headers()
        self.wfile.write(content)

    def safe_static_path(self, request_path: str):
        rel = unquote(request_path.removeprefix("/static/"))
        candidate = (STATIC / rel).resolve()
        try:
            candidate.relative_to(STATIC.resolve())
        except ValueError:
            return None
        return candidate

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/":
            self.send_file(STATIC / "index.html")
            return

        if path == "/api/board":
            self.send_json(load_board())
            return

        if path.startswith("/static/"):
            target = self.safe_static_path(path)
            if target is None:
                self.send_error(HTTPStatus.FORBIDDEN)
            else:
                self.send_file(target)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 50_000_000:
                return None
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def do_PUT(self):
        path = urlparse(self.path).path
        if path != "/api/board":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        data = self.read_json_body()
        if not isinstance(data, dict) or not isinstance(data.get("strokes"), list):
            self.send_json({"ok": False, "error": "invalid board"}, HTTPStatus.BAD_REQUEST)
            return

        cleaned = {
            "version": int(data.get("version", 1)),
            "strokes": data["strokes"],
            "view": data.get("view") if isinstance(data.get("view"), dict) else DEFAULT_BOARD["view"],
        }
        save_board(cleaned)
        self.send_json({"ok": True, "strokes": len(cleaned["strokes"])})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/clear":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        save_board(dict(DEFAULT_BOARD))
        self.send_json({"ok": True})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print()
    print("Local Board")
    print(f"Linux: http://127.0.0.1:{PORT}")
    print(f"iPad:  http://<IP_твоего_Linux>:{PORT}")
    print("Остановить: Ctrl+C")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка.")
    finally:
        server.server_close()
