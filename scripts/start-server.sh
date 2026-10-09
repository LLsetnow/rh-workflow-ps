#!/bin/zsh
set -eu
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
exec uv run python -m backend.webview_server --port 8768 "$@"
