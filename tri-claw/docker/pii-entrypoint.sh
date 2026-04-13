#!/bin/sh
# pii-entrypoint.sh — optional remote PII fixture loading before gateway start.
#
# If TRISHOOL_PII_DATA_URL is set, downloads a .tar.gz or .zip bundle from
# that URL (S3 presigned URL, GitHub raw, etc.) and extracts it into
# /home/node/.openclaw/workspace/eval/pii/, overwriting bundled fixtures.
#
# This keeps the miners' known fixtures out of the public Docker image while
# still baking in safe defaults for local/dev testing.
#
# Usage (prod):
#   docker run -e TRISHOOL_PII_DATA_URL="https://…/pii-fixtures.tar.gz" …
# Usage (dev/CI):
#   docker run …  (no env var — bundled fixtures are used as-is)

PII_DIR="/home/node/.openclaw/workspace/eval/pii"

if [ -n "$TRISHOOL_PII_DATA_URL" ]; then
  echo "[pii-entrypoint] Downloading PII fixtures from remote URL…"
  TMPFILE="$(mktemp /tmp/pii-fixtures.XXXXXX)"

  if ! curl -fsSL "$TRISHOOL_PII_DATA_URL" -o "$TMPFILE"; then
    echo "[pii-entrypoint] ERROR: failed to download $TRISHOOL_PII_DATA_URL — using bundled fixtures." >&2
    rm -f "$TMPFILE"
  else
    mkdir -p "$PII_DIR"

    # Detect format by extension in URL or by magic bytes
    case "$TRISHOOL_PII_DATA_URL" in
      *.tar.gz|*.tgz)
        tar -xzf "$TMPFILE" -C "$PII_DIR" --strip-components=1 2>/dev/null \
          || tar -xzf "$TMPFILE" -C "$PII_DIR"
        ;;
      *.zip)
        unzip -qo "$TMPFILE" -d "$PII_DIR"
        ;;
      *)
        # Try tar.gz first, then zip
        tar -xzf "$TMPFILE" -C "$PII_DIR" --strip-components=1 2>/dev/null \
          || unzip -qo "$TMPFILE" -d "$PII_DIR" 2>/dev/null \
          || echo "[pii-entrypoint] WARN: unknown archive format — skipping extraction." >&2
        ;;
    esac

    rm -f "$TMPFILE"
    echo "[pii-entrypoint] PII fixtures loaded from remote."
  fi
else
  echo "[pii-entrypoint] No TRISHOOL_PII_DATA_URL set — using bundled fixtures."
fi

# Hand off to the original command
exec "$@"
