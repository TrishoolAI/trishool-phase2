#!/usr/bin/env bash
# Bring down tri-claw (lean) and tri-judge.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$ROOT/$(basename "${BASH_SOURCE[0]}")"
# Repo-root env: same layout as docker-up.sh. Compose interpolates ${VAR} in YAML (e.g. volumes)
# from the shell *or* from --env-file — not from service env_file: alone.
# shellcheck source=scripts/ensure-trishool-env.sh
source "$ROOT/scripts/ensure-trishool-env.sh"
ensure_trishool_root_env "$ROOT"
# If we can't talk to Docker (e.g. session not in docker group), re-run with docker group
if ! docker info &>/dev/null; then
  exec sg docker -c "$(printf '%q ' "$SCRIPT_PATH" "$@")"
fi

COMPOSE_ENV_FILES=(--env-file "$ROOT/.env" --env-file "$ROOT/.env.tri-claw" --env-file "$ROOT/.env.tri-judge")

cd "$ROOT/tri-claw"
docker compose "${COMPOSE_ENV_FILES[@]}" -f docker-compose.yml -f docker-compose.lean.yml down

cd "$ROOT/tri-judge"
docker compose "${COMPOSE_ENV_FILES[@]}" down
