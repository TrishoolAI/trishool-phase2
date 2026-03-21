#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
COMPOSE_LEAN_FILE="$ROOT_DIR/docker-compose.lean.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
DOCKERFILE="$ROOT_DIR/Dockerfile"
LEAN_MODE=false
FORCE_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --lean)
      LEAN_MODE=true
      IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:lean}"
      DOCKERFILE="$ROOT_DIR/Dockerfile.lean"
      ;;
    --build)
      FORCE_BUILD=true
      ;;
  esac
done
EXTRA_MOUNTS="${OPENCLAW_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${OPENCLAW_HOME_VOLUME:-}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

contains_disallowed_chars() {
  local value="$1"
  [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\t'* ]]
}

validate_mount_path_value() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    fail "$label cannot be empty."
  fi
  if contains_disallowed_chars "$value"; then
    fail "$label contains unsupported control characters."
  fi
  if [[ "$value" =~ [[:space:]] ]]; then
    fail "$label cannot contain whitespace."
  fi
}

validate_named_volume() {
  local value="$1"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    fail "OPENCLAW_HOME_VOLUME must match [A-Za-z0-9][A-Za-z0-9_.-]* when using a named volume."
  fi
}

validate_mount_spec() {
  local mount="$1"
  if contains_disallowed_chars "$mount"; then
    fail "OPENCLAW_EXTRA_MOUNTS entries cannot contain control characters."
  fi
  # Keep mount specs strict to avoid YAML structure injection.
  # Expected format: source:target[:options]
  if [[ ! "$mount" =~ ^[^[:space:],:]+:[^[:space:],:]+(:[^[:space:],:]+)?$ ]]; then
    fail "Invalid mount format '$mount'. Expected source:target[:options] without spaces."
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"

validate_mount_path_value "OPENCLAW_CONFIG_DIR" "$OPENCLAW_CONFIG_DIR"
validate_mount_path_value "OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_WORKSPACE_DIR"
if [[ -n "$HOME_VOLUME_NAME" ]]; then
  if [[ "$HOME_VOLUME_NAME" == *"/"* ]]; then
    validate_mount_path_value "OPENCLAW_HOME_VOLUME" "$HOME_VOLUME_NAME"
  else
    validate_named_volume "$HOME_VOLUME_NAME"
  fi
fi
if contains_disallowed_chars "$EXTRA_MOUNTS"; then
  fail "OPENCLAW_EXTRA_MOUNTS cannot contain control characters."
fi

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"
# Seed device-identity parent eagerly for Docker Desktop/Windows bind mounts
# that reject creating new subdirectories from inside the container.
mkdir -p "$OPENCLAW_CONFIG_DIR/identity"

TRISHOOL_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
# shellcheck source=../scripts/ensure-trishool-env.sh
source "$TRISHOOL_ROOT/scripts/ensure-trishool-env.sh"
ensure_trishool_root_env "$TRISHOOL_ROOT"

# Load repo-root env for compose interpolation (never write files back).
# Precedence: vars exported before this script win; then .env.tri-claw overrides .env for same keys.
mapfile -t _TRISHOOL_INITIAL_EXPORTS < <(compgen -e || true)

_was_exported_before_trishool_env_load() {
  local k="$1"
  local e
  for e in "${_TRISHOOL_INITIAL_EXPORTS[@]}"; do
    [[ "$e" == "$k" ]] && return 0
  done
  return 1
}

_load_trishool_env_file() {
  local file="$1"
  local mode="$2"
  [[ -f "$file" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    key="${line%%=*}"
    key="${key% }"
    key="${key#"${key%%[![:space:]]*}"}"
    [[ -z "$key" ]] && continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ "$mode" == "unset_only" ]]; then
      if [[ -z "${!key+x}" ]]; then
        export "$key=$value"
      fi
    else
      if _was_exported_before_trishool_env_load "$key"; then
        continue
      fi
      export "$key=$value"
    fi
  done <"$file"
}

_load_trishool_env_file "$TRISHOOL_ROOT/.env" unset_only
_load_trishool_env_file "$TRISHOOL_ROOT/.env.tri-claw" override_repo

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_IMAGE="$IMAGE_NAME"
if [[ "$LEAN_MODE" == "true" ]]; then
  export OPENCLAW_LEAN=1
  export OPENCLAW_SKIP_CHANNELS=1
  echo "==> Lean mode: terminal + API + memory only (no channels)"
fi
export OPENCLAW_DOCKER_APT_PACKAGES="${OPENCLAW_DOCKER_APT_PACKAGES:-}"
export OPENCLAW_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export OPENCLAW_HOME_VOLUME="$HOME_VOLUME_NAME"

if [[ "$LEAN_MODE" == "true" ]]; then
  if [[ -z "${OPENCLAW_GATEWAY_PASSWORD:-}" ]]; then
    fail "OPENCLAW_GATEWAY_PASSWORD must be set for lean mode. Add it to trishool/.env.tri-claw (or .env) or export it before running."
  fi
else
  if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    fail "OPENCLAW_GATEWAY_TOKEN must be set. Add it to trishool/.env.tri-claw (or .env) or export it before running."
  fi
fi
export OPENCLAW_GATEWAY_TOKEN
export OPENCLAW_GATEWAY_PASSWORD

COMPOSE_FILES=("$COMPOSE_FILE")
if [[ "$LEAN_MODE" == "true" && -f "$COMPOSE_LEAN_FILE" ]]; then
  COMPOSE_FILES+=("$COMPOSE_LEAN_FILE")
fi
COMPOSE_ARGS=()

write_extra_compose() {
  local home_volume="$1"
  shift
  local mount
  local gateway_home_mount
  local gateway_config_mount
  local gateway_workspace_mount

  cat >"$EXTRA_COMPOSE_FILE" <<'YAML'
services:
  openclaw-gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    gateway_home_mount="${home_volume}:/home/node"
    gateway_config_mount="${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw"
    gateway_workspace_mount="${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace"
    validate_mount_spec "$gateway_home_mount"
    validate_mount_spec "$gateway_config_mount"
    validate_mount_spec "$gateway_workspace_mount"
    printf '      - %s\n' "$gateway_home_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_config_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_workspace_mount" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    validate_mount_spec "$mount"
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  cat >>"$EXTRA_COMPOSE_FILE" <<'YAML'
  openclaw-cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s\n' "$gateway_home_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_config_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_workspace_mount" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    validate_mount_spec "$mount"
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    validate_named_volume "$home_volume"
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

VALID_MOUNTS=()
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      VALID_MOUNTS+=("$mount")
    fi
  done
fi

if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  # Bash 3.2 + nounset treats "${array[@]}" on an empty array as unbound.
  if [[ ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    write_extra_compose "$HOME_VOLUME_NAME" "${VALID_MOUNTS[@]}"
  else
    write_extra_compose "$HOME_VOLUME_NAME"
  fi
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
done
COMPOSE_HINT="docker compose"
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_HINT+=" -f ${compose_file}"
done

# Never update env files; required vars must be in trishool/.env / .env.tri-claw or exported before running.

build_image() {
  echo "==> Building Docker image: $IMAGE_NAME"
  docker build \
    --build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}" \
    -t "$IMAGE_NAME" \
    -f "$DOCKERFILE" \
    "$ROOT_DIR"
}

image_exists() {
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1
}

if [[ "$IMAGE_NAME" == "openclaw:local" || "$IMAGE_NAME" == "openclaw:lean" ]]; then
  if [[ "$FORCE_BUILD" == "true" ]]; then
    build_image
  elif ! image_exists; then
    echo "==> Image $IMAGE_NAME not found — building automatically (pass --build to force rebuild)"
    build_image
  else
    echo "==> Image $IMAGE_NAME already exists — skipping build (pass --build to force rebuild)"
  fi
else
  echo "==> Pulling Docker image: $IMAGE_NAME"
  if ! docker pull "$IMAGE_NAME"; then
    echo "ERROR: Failed to pull image $IMAGE_NAME. Please check the image name and your access permissions." >&2
    exit 1
  fi
fi

echo ""
if [[ "$LEAN_MODE" == "true" ]]; then
  echo "==> Lean mode: config + setup baked into image via openclaw.lean.json"

  if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    LEAN_CONFIG_TEMPLATE="$ROOT_DIR/docker/openclaw.lean.json"
    OPENCLAW_JSON="$OPENCLAW_CONFIG_DIR/openclaw.json"
    if [[ ! -f "$OPENCLAW_JSON" ]]; then
      echo "==> Copying lean config template to host volume"
      if [[ ! -f "$LEAN_CONFIG_TEMPLATE" ]]; then
        fail "Lean config template not found at $LEAN_CONFIG_TEMPLATE"
      fi
      cp "$LEAN_CONFIG_TEMPLATE" "$OPENCLAW_JSON"
    fi
  fi

  echo "==> Chutes config"
  echo "  CHUTES_BASE_URL: ${CHUTES_BASE_URL:-<default: https://llm.chutes.ai/v1>}"
  echo "  CHUTES_DEFAULT_MODEL_ID: ${CHUTES_DEFAULT_MODEL_ID:-<default: zai-org/GLM-4.7-TEE>}"
  echo "  CHUTES_DEFAULT_MODEL_REF: ${CHUTES_DEFAULT_MODEL_REF:-<default: chutes/zai-org/GLM-4.7-TEE>}"
  echo "  CHUTES_FAST_MODEL_ID: ${CHUTES_FAST_MODEL_ID:-<default: zai-org/GLM-4.7-Flash>}"
  echo "  CHUTES_FAST_MODEL_REF: ${CHUTES_FAST_MODEL_REF:-<default: chutes/zai-org/GLM-4.7-Flash>}"
  if [[ -n "${CHUTES_API_KEY:-}" ]]; then
    echo "  CHUTES_API_KEY: set"
  else
    echo "  CHUTES_API_KEY: NOT set (no model provider configured)"
  fi
else
  echo "==> Onboarding (interactive)"
  echo "When prompted:"
  echo "  - Gateway bind: lan"
  echo "  - Gateway auth: token"
  echo "  - Gateway token: $OPENCLAW_GATEWAY_TOKEN"
  echo "  - Tailscale exposure: Off"
  echo "  - Install Gateway daemon: No"
  echo ""
  docker compose "${COMPOSE_ARGS[@]}" run --rm openclaw-cli onboard --no-install-daemon
fi

if [[ "$LEAN_MODE" != "true" ]]; then
  echo ""
  echo "==> Provider setup (optional)"
  echo "WhatsApp (QR):"
  echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels login"
  echo "Telegram (bot token):"
  echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel telegram --token <token>"
  echo "Discord (bot token):"
  echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel discord --token <token>"
  echo "Docs: https://docs.openclaw.ai/channels"
fi

echo ""
echo "==> Starting gateway"
docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $OPENCLAW_CONFIG_DIR"
echo "Workspace: $OPENCLAW_WORKSPACE_DIR"
if [[ "$LEAN_MODE" == "true" ]]; then
  echo "Auth: password (from OPENCLAW_GATEWAY_PASSWORD)"
  echo "TUI:       ${COMPOSE_HINT} exec -it openclaw-gateway node dist/index.js tui"
  echo "Dashboard: ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js dashboard"
  echo ""
  echo "Commands:"
  echo "  ${COMPOSE_HINT} logs -f openclaw-gateway"
  echo "  ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js health"
else
  echo "Token: $OPENCLAW_GATEWAY_TOKEN"
  echo ""
  echo "Commands:"
  echo "  ${COMPOSE_HINT} logs -f openclaw-gateway"
  echo "  ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js health --token \"$OPENCLAW_GATEWAY_TOKEN\""
fi
