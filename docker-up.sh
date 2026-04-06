#!/usr/bin/env bash
# Bring up tri-shared network, tri-claw (lean), then tri-judge.
# Always builds both images (tri-claw: docker build; tri-judge: docker compose build) before starting.
# TEMPORARY (testing): default is --no-cache for both builds. Pass --cache to use Docker layer cache.
# Also: explicit --no-cache (no-op when default is already no-cache).
# Ignored (no-op): --build  →  kept for old scripts; this script always builds anyway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$ROOT/$(basename "${BASH_SOURCE[0]}")"
# Repo-root env layout: .env (shared), .env.tri-claw, .env.tri-judge (compose env_file paths)
# shellcheck source=scripts/ensure-trishool-env.sh
source "$ROOT/scripts/ensure-trishool-env.sh"
ensure_trishool_root_env "$ROOT"
# Linux: if not in docker group yet, re-run with that group (sg is from util-linux; absent on macOS).
if ! docker info &>/dev/null; then
  if command -v sg >/dev/null 2>&1; then
    exec sg docker -c "$(printf '%q ' "$SCRIPT_PATH" "$@")"
  fi
  echo "docker-up.sh: cannot reach Docker (try starting Docker Desktop, or on Linux fix socket permissions / docker group)." >&2
  exit 1
fi

# Strip trishool-only flags before docker compose (unknown service names / options)
FORWARD_ARGS=()
export TRISHOOL_EVAL_RECREATE=0
# TEMPORARY: set to 0 after testing (or use --cache on each run).
DOCKER_NO_CACHE=1
for a in "$@"; do
  case "$a" in
    --recreate)
      export TRISHOOL_EVAL_RECREATE=1
      ;;
    --cache)
      DOCKER_NO_CACHE=0
      ;;
    --no-cache)
      DOCKER_NO_CACHE=1
      ;;
    --build)
      ;; # backward compatibility; builds are unconditional
    *)
      FORWARD_ARGS+=("$a")
      ;;
  esac
done

# Create shared network if it doesn't exist
docker network inspect tri-shared &>/dev/null || docker network create tri-shared

# tri-claw lean (docker-setup.sh always builds openclaw:lean; generates eval fixtures when lean)
# Bash 3.2 + set -u: plain "${FORWARD_ARGS[@]}" errors when the array is empty; use +-guard (see tri-claw/docker-setup.sh).
TRI_CLAW_EXTRA=()
if [[ "$DOCKER_NO_CACHE" -eq 1 ]]; then
  TRI_CLAW_EXTRA+=(--no-cache)
fi
TRISHOOL_EVAL_RECREATE="$TRISHOOL_EVAL_RECREATE" \
  "$ROOT/tri-claw/docker-setup-lean.sh" ${TRI_CLAW_EXTRA[@]+"${TRI_CLAW_EXTRA[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}

# tri-judge (explicit project name so we never inherit COMPOSE_PROJECT_NAME=tri-claw from .env.tri-claw)
cd "$ROOT/tri-judge"
JUDGE_COMPOSE=(docker compose -p tri-judge --env-file "$ROOT/.env" --env-file "$ROOT/.env.tri-judge")
if [[ "$DOCKER_NO_CACHE" -eq 1 ]]; then
  "${JUDGE_COMPOSE[@]}" build --no-cache
else
  "${JUDGE_COMPOSE[@]}" build
fi
"${JUDGE_COMPOSE[@]}" up -d ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}
