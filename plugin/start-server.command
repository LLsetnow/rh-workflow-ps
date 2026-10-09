#!/bin/zsh
set -eu
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
exec ./scripts/start-server.sh --no-browser
