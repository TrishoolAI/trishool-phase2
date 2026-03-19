#!/usr/bin/env bash
# Bring down tri-claw (lean) and tri-judge.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$ROOT/$(basename "${BASH_SOURCE[0]}")"
# If we can't talk to Docker (e.g. session not in docker group), re-run with docker group
if ! docker info &>/dev/null; then
  exec sg docker -c "$(printf '%q ' "$SCRIPT_PATH" "$@")"
fi

cd "$ROOT/tri-claw"
docker compose -f docker-compose.yml -f docker-compose.lean.yml down

cd "$ROOT/tri-judge"
docker compose down
