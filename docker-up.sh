#!/usr/bin/env bash
# Bring up tri-shared network, tri-claw (lean), then tri-judge.
# Always builds both images (tri-claw: docker build; tri-judge: docker compose build) before starting.
# Optional: --no-cache  →  uncached docker build / compose build for both images.
# Optional: --local     →  start local Halo guard on the host after compose (scripts/serve_halo_guard.py).
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
export TRISHOOL_EVAL_RECREATE=1  # TEMPORARY: always recreate PII fixtures
DOCKER_NO_CACHE=0
START_LOCAL_HALO_GUARD=0
for a in "$@"; do
  case "$a" in
    --recreate)
      export TRISHOOL_EVAL_RECREATE=1
      ;;
    --no-cache)
      DOCKER_NO_CACHE=1
      ;;
    --local)
      START_LOCAL_HALO_GUARD=1
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

# Local Halo guard on the host only when docker-up.sh --local (tri-check eval --local / host.docker.internal).
if [[ "$START_LOCAL_HALO_GUARD" -eq 1 ]]; then
  # shellcheck source=scripts/trishool-resolve-python.sh
  source "$ROOT/scripts/trishool-resolve-python.sh"

  trishool_start_local_halo_guard() {
  if [[ "${TRISHOOL_SKIP_LOCAL_HALO_GUARD:-0}" == "1" ]]; then
    echo "docker-up.sh: skipping local Halo guard (TRISHOOL_SKIP_LOCAL_HALO_GUARD=1 despite --local)." >&2
    return 0
  fi
  local py script port bind model logdir logfile pidfile
  script="$ROOT/scripts/serve_halo_guard.py"
  if [[ ! -f "$script" ]]; then
    echo "docker-up.sh: skip local Halo guard (missing $script)." >&2
    return 0
  fi
  # Find a Python that has torch+transformers (needed for the guard model).
  _halo_python_has_torch() {
    "$1" -c 'import torch, transformers' >/dev/null 2>&1
  }
  if [[ -n "${HALO_GUARD_PYTHON:-}" ]]; then
    py="${HALO_GUARD_PYTHON}"
    if [[ -x "$py" ]]; then
      :
    elif command -v "$py" >/dev/null 2>&1; then
      py="$(command -v "$py")"
    else
      echo "docker-up.sh: HALO_GUARD_PYTHON not found or not executable: ${HALO_GUARD_PYTHON}" >&2
      return 0
    fi
  else
    py=""
    # First try the generic resolver, but verify it has torch.
    local _candidate
    _candidate="$(_trishool_resolve_python 2>/dev/null)" || true
    if [[ -n "$_candidate" ]] && _halo_python_has_torch "$_candidate"; then
      py="$_candidate"
    fi
    # If PATH python lacks torch, probe well-known conda / pyenv / venv paths.
    if [[ -z "$py" ]]; then
      local _probe
      for _probe in \
        "$HOME/miniconda/bin/python" \
        "$HOME/miniconda3/bin/python" \
        "$HOME/anaconda3/bin/python" \
        "$HOME/.conda/bin/python" \
        "$HOME/.pyenv/shims/python3" \
        "$HOME/.pyenv/shims/python" \
        "/opt/homebrew/bin/python3" \
        "/usr/local/bin/python3" \
        ; do
        if [[ -x "$_probe" ]] && _halo_python_has_torch "$_probe"; then
          py="$_probe"
          break
        fi
      done
    fi
    if [[ -z "$py" ]]; then
      echo "docker-up.sh: skip local Halo guard (no python with torch+transformers found on PATH or common locations)." >&2
      echo "docker-up.sh: install deps: pip install -r scripts/requirements-halo-guard.txt  OR  set HALO_GUARD_PYTHON=/path/to/python" >&2
      return 0
    fi
    echo "docker-up.sh: using python: $py" >&2
  fi
  port="${HALO_GUARD_PORT:-8000}"
  bind="${HALO_GUARD_BIND:-0.0.0.0}"
  model="${HALO_GUARD_MODEL:-astroware/Halo0.8B-guard-v1}"
  logdir="$ROOT/logs"
  mkdir -p "$logdir"
  logfile="$logdir/halo-guard.log"
  pidfile="$ROOT/.halo-guard.pid"
  if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "docker-up.sh: local Halo guard already healthy at http://127.0.0.1:${port}/health" >&2
    return 0
  fi
  echo "docker-up.sh: starting local Halo guard (model=${model}, bind=${bind}:${port}, log=${logfile})…" >&2
  halo_extra=()
  if [[ "${HALO_GUARD_NO_TRUST_REMOTE_CODE:-0}" == "1" ]]; then
    halo_extra+=(--no-trust-remote-code)
  fi
  if [[ "${HALO_GUARD_LOCAL_FILES_ONLY:-0}" == "1" ]]; then
    halo_extra+=(--local-files-only)
  fi
  (
    cd "$ROOT"
    # PYTHONUNBUFFERED ensures log lines appear in real-time under nohup.
    # serve_halo_guard.py defaults HF_HUB_DISABLE_XET=1 (classic download); set HALO_GUARD_ENABLE_XET=1 to allow Xet.
    if [[ "${HALO_GUARD_ENABLE_XET:-0}" == "1" ]]; then
      env HF_HUB_DISABLE_XET=0 PYTHONUNBUFFERED=1 nohup "$py" "$script" --model-path "$model" --host "$bind" --port "$port" ${halo_extra[@]+"${halo_extra[@]}"} >>"$logfile" 2>&1 &
    else
      PYTHONUNBUFFERED=1 nohup "$py" "$script" --model-path "$model" --host "$bind" --port "$port" ${halo_extra[@]+"${halo_extra[@]}"} >>"$logfile" 2>&1 &
    fi
    echo $! >"$pidfile"
  )
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  echo "docker-up.sh: guard pid=${pid:-?}; watching ${logfile} (model download may take a few minutes on first run) …" >&2
  local i max_wait=600
  for i in $(seq 1 "$max_wait"); do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "docker-up.sh: local Halo guard ready (pid ${pid:-?}, http://127.0.0.1:${port})" >&2
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "docker-up.sh: local Halo guard exited during startup (see ${logfile}); set TRISHOOL_SKIP_LOCAL_HALO_GUARD=1 to skip." >&2
      if [[ -f "$logfile" ]] && [[ -s "$logfile" ]]; then
        echo "docker-up.sh: tail of ${logfile}:" >&2
        tail -n 40 "$logfile" >&2 || true
      fi
      rm -f "$pidfile"
      return 0
    fi
    # Print periodic progress every 15s (tail last few lines — single-line tail can repeat on Xet retries)
    if (( i % 15 == 0 )); then
      local tail_log
      tail_log="$(tail -n 5 "$logfile" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' || true)"
      echo "docker-up.sh: still waiting (${i}/${max_wait}s) … ${tail_log}" >&2
    fi
    sleep 1
  done
  echo "docker-up.sh: local Halo guard not healthy after ${max_wait}s (pid ${pid:-?}); see ${logfile}" >&2
  }

  trishool_start_local_halo_guard
fi
