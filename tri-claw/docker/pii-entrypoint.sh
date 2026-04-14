#!/bin/sh
# pii-entrypoint.sh — PII fixture bootstrap before gateway start.
#
# Priority order:
#   1. TRISHOOL_PII_DATA_URL set → download .tar.gz/.zip from URL (validator override / coordinated rounds)
#   2. Otherwise → seed-based generation:
#        a. PII_SEED_FILE exists and TRISHOOL_EVAL_RECREATE != 1 → reuse existing seed (stable across restarts)
#        b. No seed file or TRISHOOL_EVAL_RECREATE=1 → generate fresh random seed, save it
#        Then run generate-pii-runtime.py --seed <seed>
#
# Seed file location: $OPENCLAW_DIR/pii-seed  (inside the openclaw bind-mount, survives restarts)
# Each validator gets a unique seed generated on first start; miners cannot predict PII values.

OPENCLAW_DIR="${OPENCLAW_DIR:-/home/node/.openclaw}"
PII_DIR="${OPENCLAW_DIR}/workspace"
PII_SEED_FILE="${OPENCLAW_DIR}/pii-seed"
PII_SCRIPT="/app/docker/generate-pii-runtime.py"

# ── Path 1: remote fixture override ─────────────────────────────────────────
if [ -n "$TRISHOOL_PII_DATA_URL" ]; then
  echo "[pii-entrypoint] Downloading PII fixtures from remote URL…"
  TMPFILE="$(mktemp /tmp/pii-fixtures.XXXXXX)"

  if ! curl -fsSL "$TRISHOOL_PII_DATA_URL" -o "$TMPFILE"; then
    echo "[pii-entrypoint] ERROR: download failed — falling through to seed-based generation." >&2
    rm -f "$TMPFILE"
  else
    EXTRACT_DIR="${PII_DIR}/eval/pii"
    mkdir -p "$EXTRACT_DIR"
    case "$TRISHOOL_PII_DATA_URL" in
      *.tar.gz|*.tgz)
        tar -xzf "$TMPFILE" -C "$EXTRACT_DIR" --strip-components=1 2>/dev/null \
          || tar -xzf "$TMPFILE" -C "$EXTRACT_DIR"
        ;;
      *.zip)
        unzip -qo "$TMPFILE" -d "$EXTRACT_DIR"
        ;;
      *)
        tar -xzf "$TMPFILE" -C "$EXTRACT_DIR" --strip-components=1 2>/dev/null \
          || unzip -qo "$TMPFILE" -d "$EXTRACT_DIR" 2>/dev/null \
          || echo "[pii-entrypoint] WARN: unknown archive format — skipping extraction." >&2
        ;;
    esac
    rm -f "$TMPFILE"
    echo "[pii-entrypoint] PII fixtures loaded from remote."
    exec "$@"
  fi
fi

# ── Path 2: seed-based local generation ─────────────────────────────────────

# Rotate seed if TRISHOOL_EVAL_RECREATE=1 is set.
if [ "${TRISHOOL_EVAL_RECREATE:-0}" = "1" ] && [ -f "$PII_SEED_FILE" ]; then
  echo "[pii-entrypoint] TRISHOOL_EVAL_RECREATE=1 — rotating PII seed."
  rm -f "$PII_SEED_FILE"
fi

# Generate a new seed if none exists.
if [ ! -f "$PII_SEED_FILE" ]; then
  # Use /dev/urandom for 32 bytes of hex entropy (256-bit seed).
  NEW_SEED="$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  if [ -z "$NEW_SEED" ]; then
    # Fallback: use $RANDOM + timestamp if od/dd unavailable.
    NEW_SEED="$(date +%s%N 2>/dev/null || date +%s)${RANDOM}${RANDOM}${RANDOM}"
  fi
  printf '%s' "$NEW_SEED" > "$PII_SEED_FILE"
  echo "[pii-entrypoint] Generated new PII seed → ${PII_SEED_FILE}"
else
  echo "[pii-entrypoint] Reusing existing PII seed from ${PII_SEED_FILE}"
fi

SEED="$(cat "$PII_SEED_FILE")"

if [ -z "$SEED" ]; then
  echo "[pii-entrypoint] ERROR: empty seed — using bundled fixtures as-is." >&2
  exec "$@"
fi

# Run the runtime PII generator.
if [ -f "$PII_SCRIPT" ]; then
  echo "[pii-entrypoint] Generating PII fixtures (seed=${SEED%????????????????????????????????????????????????????????????????}…)"
  python3 "$PII_SCRIPT" --pii-dir "$PII_DIR" --seed "$SEED" \
    || echo "[pii-entrypoint] WARN: PII generation failed — using bundled fixtures." >&2
else
  echo "[pii-entrypoint] WARN: ${PII_SCRIPT} not found — using bundled fixtures." >&2
fi

# Hand off to the original command.
exec "$@"
