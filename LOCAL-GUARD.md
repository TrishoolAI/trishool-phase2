# Local Halo guard (`--local`)

This guide covers **only** the workflow where the **guard classify** call runs on your machine ([`scripts/serve_halo_guard.py`](scripts/serve_halo_guard.py)) while the **OpenClaw agent** still uses **Chutes** as usual. Use it with **`bash docker-up.sh --local`** and **`pnpm eval … --local`** / **`pnpm guard-probe … --local`** from [`tri-check/`](tri-check/README.md).

You need a **tri-claw gateway built from this repository** so it honors `X-Openclaw-Guard-*` headers from tri-check.

---

## What gets installed where

| Piece | Location | Purpose |
|--------|----------|---------|
| Docker stack | Repo root | OpenClaw (`:18789`) + Judge (`:8080`) |
| Host Python + deps | Your machine | Loads `astroware/Halo0.8B-guard-v1` and serves `:8000` |
| tri-check | `tri-check/` | Sends classify overrides to the gateway when you pass `--local` |

---

## 1. Prerequisites

- **Docker** + Docker Compose (same as main [README.md](README.md)).
- **Node.js 18+** and **pnpm** if you use tri-check.
- **Python 3.8+** with a working **PyTorch** install (CPU or GPU). A **conda** or **venv** environment is recommended so `torch` is not confused with a system `python3` that lacks it.

---

## 2. Installation

### 2.1 Repository and Docker env (once)

From the **repository root**:

```bash
git clone https://github.com/TrishoolAI/trishool-phase2.git
cd trishool-phase2
cp .env.example .env
cp .env.tri-claw.example .env.tri-claw
cp .env.tri-judge.example .env.tri-judge
```

Fill in at least: `OPENCLAW_GATEWAY_PASSWORD` (same in `.env` and `.env.tri-claw`), `CHUTES_API_KEY`, and judge/tri-claw values as in the main README.

### 2.2 Halo guard Python dependencies (host)

Still from the **repository root**, using the **same** interpreter you want `docker-up.sh` to use (or set `HALO_GUARD_PYTHON` later):

```bash
pip install -r scripts/requirements-halo-guard.txt
```

Verify:

```bash
python -c "import torch, transformers; print(torch.__version__, transformers.__version__)"
```

You need a recent **transformers** release that supports the **Qwen3.5** (`qwen3_5`) architecture (see the version floor in `scripts/requirements-halo-guard.txt`).

### 2.3 tri-check (optional but typical)

```bash
cd tri-check
pnpm install
cp .env.example .env
```

Edit **`tri-check/.env`**: `OPENCLAW_URL`, `JUDGE_URL`, gateway password (must match `.env.tri-claw`), and `CHUTES_API_KEY` for the agent.

### 2.4 Classify URL for Dockerized OpenClaw

OpenClaw runs **inside a container**. It must reach the guard on the **host** at port **8000**.

Add to **`tri-check/.env`** (tri-check loads this file first; repo-root `.env` does not override already-set variables):

```bash
HALO_LOCAL_CLASSIFY_URL=http://host.docker.internal:8000/v1/classify
```

- **Docker Desktop** (macOS / Windows): `host.docker.internal` usually works.
- **Linux**: use the host’s LAN IP, or add `host.docker.internal` via Docker `extra_hosts` / `host-gateway` (see [Docker docs](https://docs.docker.com/desktop/features/host-gateway/)).

Optional:

```bash
HALO_LOCAL_CLASSIFY_MODEL=astroware/Halo0.8B-guard-v1
```

---

## 3. Environment variables (reference)

### Host guard process (`docker-up.sh` / `serve_halo_guard.py`)

Set in the **shell** before `docker-up.sh`, or document in repo-root `.env.example` (note: `docker-up.sh` does not load all of these from `.env` automatically for the child process unless your shell exports them).

| Variable | Meaning |
|----------|---------|
| `HALO_GUARD_PYTHON` | Absolute path to `python` with `torch` + `transformers` |
| `HALO_GUARD_BIND` | Default `0.0.0.0` |
| `HALO_GUARD_PORT` | Default `8000` |
| `HALO_GUARD_MODEL` | Default `astroware/Halo0.8B-guard-v1` |
| `HALO_GUARD_LOCAL_FILES_ONLY=1` | Pass `--local-files-only` (Hub cache only) |
| `HALO_GUARD_ENABLE_XET=1` | Re-enable Hugging Face Xet (default in script is classic HTTP) |
| `TRISHOOL_SKIP_LOCAL_HALO_GUARD=1` | Skip starting the guard even if you passed `--local` to `docker-up.sh` |
| `HF_HUB_OFFLINE=1` | Use with a fully cached model to avoid any Hub network access |

Full list and comments: [`.env.example`](.env.example).

### tri-check (`tri-check/.env`)

| Variable | Meaning |
|----------|---------|
| `HALO_LOCAL_CLASSIFY_URL` | POST target for classify (must be reachable **from the OpenClaw container**) |
| `HALO_LOCAL_CLASSIFY_MODEL` | Model id in the JSON body |

---

## 4. Start everything

### Recommended: Docker + guard in one step

From the **repository root**:

```bash
bash docker-up.sh --local
```

This builds/starts tri-claw and tri-judge, then starts the guard in the background. Logs: **`logs/halo-guard.log`**. PID: **`.halo-guard.pid`**.

First model download can take several minutes; startup waits up to **600s** for `/health`.

### Start the guard only (manual)

If Docker is already up:

```bash
python scripts/serve_halo_guard.py \
  --model-path astroware/Halo0.8B-guard-v1 \
  --host 0.0.0.0 \
  --port 8000
```

With a cached model and no Hub access:

```bash
python scripts/serve_halo_guard.py \
  --model-path astroware/Halo0.8B-guard-v1 \
  --host 0.0.0.0 \
  --port 8000 \
  --local-files-only
```

Combine with `HF_HUB_OFFLINE=1` if proxies break Hub calls.

### Health check (host)

```bash
curl -s http://127.0.0.1:8000/health
```

---

## 5. Run tri-check with `--local`

From **`tri-check/`**:

```bash
# Full OpenClaw → Judge eval; guard classify goes to local server
pnpm eval --question Q11 --prompt "Your prompt" --local

# Guard path only (no judge)
pnpm guard-probe -- --query "Your prompt" --local
pnpm guard-probe -- --query "..." --local --role output
```

`CHUTES_API_KEY` is still required for the **agent**; the local classify URL does not use a Chutes Bearer token.

Batch mode:

```bash
pnpm eval --submission data/example-submission.json --local
```

---

## 6. How it fits together

1. tri-check adds **`X-Openclaw-Guard-*`** headers so the gateway’s guard plugin POSTs to your **`HALO_LOCAL_CLASSIFY_URL`** instead of Chutes.
2. **`serve_halo_guard.py`** uses the same prompting shape as [`scripts/qwen35_guard_runtime.py`](scripts/qwen35_guard_runtime.py) (default guard system prompt, `Safety:` generation prefix, `enable_thinking=False` when the tokenizer supports it) so local scores align with the intended Halo behavior.
3. The **LLM** behind the agent is unchanged (still Chutes via OpenClaw).

---

## 7. Troubleshooting

| Symptom | What to check |
|---------|----------------|
| `docker-up.sh` skips the guard | No Python with `import torch, transformers`. Set `HALO_GUARD_PYTHON` or install `scripts/requirements-halo-guard.txt` in that env. |
| Guard exits / empty log | `tail -n 80 logs/halo-guard.log`. Hub proxy errors: try `HF_HUB_OFFLINE=1` + cached model + `--local-files-only`. |
| **`502` / `fetch failed`** with `pnpm eval --local` | OpenClaw container cannot reach `127.0.0.1:8000`. Set `HALO_LOCAL_CLASSIFY_URL=http://host.docker.internal:8000/v1/classify` in **`tri-check/.env`**. |
| Everything classified **HARMLESS** | Use current `serve_halo_guard.py` from this repo (system prompt + `Safety:` prefix + thinking disabled). |
| Wrong `python` picked (e.g. Homebrew without torch) | `HALO_GUARD_PYTHON=/path/to/conda/bin/python bash docker-up.sh --local` |

---

## 8. Related files

| File | Role |
|------|------|
| [`docker-up.sh`](docker-up.sh) | `--local` starts the guard after compose |
| [`scripts/serve_halo_guard.py`](scripts/serve_halo_guard.py) | HTTP `/v1/classify`, `/health` |
| [`scripts/requirements-halo-guard.txt`](scripts/requirements-halo-guard.txt) | Pip dependencies |
| [`scripts/qwen35_guard_runtime.py`](scripts/qwen35_guard_runtime.py) | Reference prompting / parsing |
| [`tri-check/README.md`](tri-check/README.md) | Full tri-check usage (non-local included) |
