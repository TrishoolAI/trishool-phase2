#!/usr/bin/env bash
# Diagnose where OpenClaw lean auth/credentials come from.
# Run from repo root, or pass container ID: ./scripts/diagnose-lean-auth.sh [container_id]
set -euo pipefail
CONTAINER="${1:-}"
SCOPE="host"
if [[ -n "$CONTAINER" ]]; then
  SCOPE="container $CONTAINER"
  run_cmd() { docker exec "$CONTAINER" "$@"; }
  run_test() { docker exec "$CONTAINER" test "$@" 2>/dev/null; }
else
  run_cmd() { "$@"; }
  run_test() { test "$@" 2>/dev/null; }
fi

echo "=== OpenClaw Lean Auth Diagnostics ($SCOPE) ==="
echo ""

# Paths (container uses /home/node/.openclaw, host uses OPENCLAW_CONFIG_DIR)
if [[ -n "$CONTAINER" ]]; then
  BASE="/home/node/.openclaw"
else
  BASE="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
fi

echo "--- 1. Config base ---"
echo "BASE: $BASE"
run_cmd ls -la "$BASE" 2>/dev/null || echo "(dir not found or not accessible)"
echo ""

echo "--- 2. openclaw.json (redact apiKey values) ---"
if run_test -f "$BASE/openclaw.json"; then
  run_cmd cat "$BASE/openclaw.json" 2>/dev/null | sed -E 's/"apiKey"\s*:\s*"[^"]*"/"apiKey":"<REDACTED>"/g' || true
else
  echo "(openclaw.json not found)"
fi
echo ""

echo "--- 3. Auth store paths (auth-profiles.json lives in agents/main/agent/) ---"
for p in "$BASE/agents/main/agent/auth-profiles.json" "$BASE/agents/main/auth-profiles.json" "$BASE/auth-profiles.json"; do
  run_test -f "$p" && echo "EXISTS: $p" || echo "missing: $p"
done
echo ""

echo "--- 4. Legacy auth.json ---"
for p in "$BASE/agents/main/agent/auth.json" "$BASE/agents/main/auth.json" "$BASE/auth.json"; do
  run_test -f "$p" && echo "EXISTS: $p" || true
done
echo ""

echo "--- 5. Credentials dir ---"
run_cmd ls -la "$BASE/credentials" 2>/dev/null || echo "(credentials dir not found)"
echo ""

echo "--- 6. Full agents tree ---"
run_cmd find "$BASE/agents" -type f 2>/dev/null || echo "(agents dir not found)"
echo ""

echo "--- 7. Env (container only): CHUTES_API_KEY, ANTHROPIC_API_KEY set? ---"
if [[ -n "$CONTAINER" ]]; then
  run_cmd sh -c 'echo "CHUTES_API_KEY length: ${#CHUTES_API_KEY:-0}"; echo "ANTHROPIC_API_KEY length: ${#ANTHROPIC_API_KEY:-0}"' 2>/dev/null || true
fi
