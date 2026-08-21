#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

. .venv/bin/activate
python -m pip install -q --upgrade pip
python -m pip install -q -e .

exec uvicorn local_board.main:app \
  --host "${LOCAL_BOARD_HOST:-0.0.0.0}" \
  --port "${LOCAL_BOARD_PORT:-8000}"
