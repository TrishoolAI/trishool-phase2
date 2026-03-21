#!/usr/bin/env bash
# Ensure repo-root env files exist so docker compose env_file entries resolve.
# Idempotent: creates empty files only when missing (user fills or copies from *.example).
ensure_trishool_root_env() {
  local root="$1"
  local name path
  for name in .env .env.tri-claw .env.tri-judge; do
    path="$root/$name"
    if [[ ! -f "$path" ]]; then
      echo "Note: creating empty $name at repo root — add values or copy from ${name}.example" >&2
      touch "$path"
    fi
  done
}
