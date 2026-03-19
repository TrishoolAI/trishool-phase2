# Docker Commands Reference (Lean)

All commands run from the **repo root**. Save a shell alias to cut the typing:

```bash
alias oc="docker compose -f docker-compose.yml -f docker-compose.lean.yml"
```

After setup, everything runs **inside the gateway container** via `exec` — no second CLI container needed.

---

## Setup

```bash
# First-time lean setup: copies docker/openclaw.lean.json to config dir (if absent),
# creates workspace, then starts gateway. Requires OPENCLAW_GATEWAY_PASSWORD + CHUTES_API_KEY in .env.
./docker-setup-lean.sh
```

---

## Gateway

```bash
# Start gateway in background
docker compose -f docker-compose.yml -f docker-compose.lean.yml up -d openclaw-gateway

# Stop / restart
docker compose -f docker-compose.yml -f docker-compose.lean.yml stop openclaw-gateway
docker compose -f docker-compose.yml -f docker-compose.lean.yml restart openclaw-gateway

# Tail logs
docker compose -f docker-compose.yml -f docker-compose.lean.yml logs -f openclaw-gateway

# Health check
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js health
```

---

## Terminal UI (TUI)

```bash
# Open TUI (gateway must be running)
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec -it openclaw-gateway node dist/index.js tui

# TUI on a specific session
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec -it openclaw-gateway node dist/index.js tui --session main

# Send a one-shot message
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js message send "Hello!"
```

---

## Control UI (Dashboard)

```bash
# Open dashboard URL (auto-connects with password in URL fragment)
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js dashboard

# Get URL only (no browser open)
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js dashboard --no-open
```

Dashboard URL: http://localhost:18789/

---

## HTTP API (Chat Completions)

Lean enables the OpenAI-compatible `/v1/chat/completions` endpoint by default. Auth with your gateway password:

```bash
curl -X POST http://localhost:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"model":"openclaw:main","messages":[{"role":"user","content":"Hello"}]}'
```

Use `OPENCLAW_GATEWAY_PASSWORD` from `.env` as the Bearer token.

---

## Config

```bash
# View running config
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js config show

# Set a config value
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js config set <key> <value>
```

---

## Chutes / Provider Debug

```bash
# Show Chutes env (no secrets)
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway sh -c '
  echo "=== Chutes env ==="
  echo "CHUTES_BASE_URL=${CHUTES_BASE_URL:-<not set>}"
  echo "CHUTES_DEFAULT_MODEL_ID=${CHUTES_DEFAULT_MODEL_ID:-<not set>}"
  echo "CHUTES_DEFAULT_MODEL_REF=${CHUTES_DEFAULT_MODEL_REF:-<not set>}"
  echo "CHUTES_FAST_MODEL_ID=${CHUTES_FAST_MODEL_ID:-<not set>}"
  echo "CHUTES_FAST_MODEL_REF=${CHUTES_FAST_MODEL_REF:-<not set>}"
  echo "CHUTES_API_KEY set: $([ -n "${CHUTES_API_KEY:-}" ] && echo YES || echo NO)"
'

# View provider config from config file
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js config show --section models
```

---

## Shell / Debug

```bash
# Interactive shell inside gateway container
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec -it openclaw-gateway sh

# Status overview
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway node dist/index.js status
```

---

## Debug and export logs

When something goes wrong, use these to inspect and save logs.

**1. Live tail (stdout/stderr)**  
Same as Gateway section — Docker captures the process’s console output:

```bash
docker compose -f docker-compose.yml -f docker-compose.lean.yml logs -f openclaw-gateway
```

**2. Where Docker stores logs**  
Compose uses the `json-file` driver (see `docker-compose.lean.yml`). Docker writes to a path on the host and rotates by size. To get that path:

```bash
CONTAINER=$(docker compose -f docker-compose.yml -f docker-compose.lean.yml ps -q openclaw-gateway)
docker inspect --format='{{.LogPath}}' "$CONTAINER"
```

**3. Export Docker logs to a file you choose**  
One-shot snapshot (run after reproducing the issue):

```bash
docker compose -f docker-compose.yml -f docker-compose.lean.yml logs openclaw-gateway > openclaw-gateway.log 2>&1
```

Stream and append to a file (run in background or another terminal; logs go to both stdout and the file):

```bash
docker compose -f docker-compose.yml -f docker-compose.lean.yml logs -f openclaw-gateway 2>&1 | tee -a ./gateway.log
```

To run the stream in the background and keep writing to a file:

```bash
nohup docker compose -f docker-compose.yml -f docker-compose.lean.yml logs -f openclaw-gateway >> ./gateway.log 2>&1 &
```

**4. Copy the internal JSONL log file out**  
The gateway also writes a rolling JSONL log inside the container. To pull the latest file to your host:

```bash
# Find the latest log file and copy it out (replace CONTAINER_ID or use the service name)
CONTAINER=$(docker compose -f docker-compose.yml -f docker-compose.lean.yml ps -q openclaw-gateway)
docker cp "$CONTAINER:/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" ./openclaw-export.log
```

If the date doesn’t match (e.g. container timezone), exec in and copy by name:

```bash
docker compose -f docker-compose.yml -f docker-compose.lean.yml exec openclaw-gateway sh -c 'ls -t /tmp/openclaw/openclaw-*.log 2>/dev/null | head -1'
# Then docker cp CONTAINER:/tmp/openclaw/openclaw-YYYY-MM-DD.log ./
```

**5. More verbose logging for a single run**  
Restart the gateway with a higher log level (config and env are baked in for lean; override with env when running):

```bash
docker compose -f docker-compose.yml -f docker-compose.lean.yml run --rm -e OPENCLAW_LOG_LEVEL=debug openclaw-gateway node dist/index.js gateway --bind lan --port 18789
```

Or add to your lean stack by setting `OPENCLAW_LOG_LEVEL=debug` in `.env` and restarting with `docker compose ... up -d openclaw-gateway`.

**6. Persist logs on the host (optional)**  
To have the internal log file written to a host directory (so you can tail or archive it without `docker cp`), use a bind mount and point logging there. Example: create a dir and use an extra mount (if your setup supports `OPENCLAW_EXTRA_MOUNTS`), or add a `logging.file` path that matches a volume you add to the compose. For the default lean setup (no volumes), the options above (Docker logs export + occasional `docker cp` of `/tmp/openclaw/*.log`) are usually enough.

---

## Teardown

```bash
# Stop all containers (keep volumes/config)
docker compose -f docker-compose.yml -f docker-compose.lean.yml down

# Full teardown including volumes (destructive!)
docker compose -f docker-compose.yml -f docker-compose.lean.yml down -v
```
