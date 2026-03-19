#!/usr/bin/env bash
# Bring up tri-shared network, tri-claw (lean), then tri-judge.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$ROOT/$(basename "${BASH_SOURCE[0]}")"
# If we can't talk to Docker (e.g. session not in docker group), re-run with docker group
if ! docker info &>/dev/null; then
  exec sg docker -c "$(printf '%q ' "$SCRIPT_PATH" "$@")"
fi

# Create shared network if it doesn't exist
docker network inspect tri-shared &>/dev/null || docker network create tri-shared

# tri-claw lean (runs docker-setup.sh --lean)
"$ROOT/tri-claw/docker-setup-lean.sh" "$@"

# tri-judge
cd "$ROOT/tri-judge"
docker compose up -d
