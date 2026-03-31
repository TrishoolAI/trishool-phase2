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
# Linux: if not in docker group yet, re-run with that group (sg is from util-linux; absent on macOS).
if ! docker info &>/dev/null; then
  if command -v sg >/dev/null 2>&1; then
    exec sg docker -c "$(printf '%q ' "$SCRIPT_PATH" "$@")"
  fi
  echo "docker-down.sh: cannot reach Docker (try starting Docker Desktop, or on Linux fix socket permissions / docker group)." >&2
  exit 1
fi

COMPOSE_ENV_FILES=(--env-file "$ROOT/.env" --env-file "$ROOT/.env.tri-claw" --env-file "$ROOT/.env.tri-judge")
# tri-judge: do NOT pass .env.tri-claw here — it sets COMPOSE_PROJECT_NAME=tri-claw, so compose would
# tear down the wrong project and leave tri-judge-tri-judge-* running. Match docker-up.sh (-p tri-judge).
TRIJUDGE_COMPOSE_ENV=(--env-file "$ROOT/.env" --env-file "$ROOT/.env.tri-judge")

cd "$ROOT/tri-claw"
docker compose "${COMPOSE_ENV_FILES[@]}" -f docker-compose.yml -f docker-compose.lean.yml down

cd "$ROOT/tri-judge"
docker compose -p tri-judge "${TRIJUDGE_COMPOSE_ENV[@]}" down
