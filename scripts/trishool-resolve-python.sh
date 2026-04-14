#!/usr/bin/env bash
# Prefer python3; fall back to python if it is Python 3.8+ (validator / CI hosts vary).
# Same logic as historically inlined in tri-claw/docker-setup.sh.
_trishool_resolve_python() {
  local c
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 \
      && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}
