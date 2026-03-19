#!/usr/bin/env bash
# Lean OpenClaw Docker setup: terminal + API + memory only.
# Equivalent to: ./docker-setup.sh --lean
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT_DIR/docker-setup.sh" --lean "$@"
