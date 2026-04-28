# Chutes and OpenRouter (Trishool eval stack)

Short guide: lean JSON for **which** models and URLs, `.env` for **secrets** and (only where needed) client–server alignment for the judge.

---

## 1. OpenClaw (tri-claw)

**Config file:** [`tri-claw/docker/openclaw.lean.json`](../tri-claw/docker/openclaw.lean.json)

- **Chutes:** `models.providers.chutes` (`baseUrl`, `models[]`) and agent refs like `chutes/Qwen/Qwen3-32B-TEE`.
- **OpenRouter:** `models.providers.openrouter` and refs like `openrouter/<vendor>/<model-id>`.
- **Default agent model** stays under `agents.defaults.model.primary` (often Chutes). Use `agents.defaults.models` aliases (e.g. `openrouter-default`) to point at an OpenRouter ref without changing primary.

**Secrets (repo root `.env` or `tri-check/.env`):**

| Variable | Role |
|----------|------|
| `CHUTES_API_KEY` | Sent as `X-Chutes-Api-Key` on OpenClaw `POST /v1/chat/completions` when you use Chutes-backed models. |
| `OPENROUTER_API_KEY` | Sent as `X-OpenRouter-Api-Key` when set; OpenClaw merges per-request provider keys so OpenRouter models can authenticate. |

You can set **both** if the gateway may use Chutes for the main model and OpenRouter for another path (or you switch models later).

---

## 2. Judge (tri-judge)

**Config file:** [`tri-judge/docker/judge.lean.json`](../tri-judge/docker/judge.lean.json)

- `judge.provider`: `"chutes"` or `"openrouter"` — selects which block under `judge.providers` is active (`baseURL` + `models` chain).
- Shared knobs stay on `judge`: `timeoutMs`, `maxRetries`, `temperature`, `maxOutputTokens`.

**Secrets:** the judge container does **not** read API keys from its own env for upstream LLM calls. Callers send a key per request:

- `Authorization: Bearer <key>`
- `X-OpenRouter-Api-Key`
- `X-Chutes-Api-Key` (same value forwarded as Bearer upstream; name is legacy)

**tri-check / PM2 validator** (`alignet/validator/agent_client.py`) do not read `judge.lean.json`. They must send the header that matches the active judge upstream:

| Variable | Role |
|----------|------|
| `CHUTES_API_KEY` | Used for judge when `JUDGE_LLM_PROVIDER` is unset or `chutes` (default). |
| `OPENROUTER_API_KEY` | Used for judge when `JUDGE_LLM_PROVIDER=openrouter`. |
| `JUDGE_LLM_PROVIDER` | `chutes` (default) or `openrouter` — **must match** `judge.provider` in `judge.lean.json`. |

If you only use Chutes on the judge, set `judge.provider` to `chutes` and you can ignore `OPENROUTER_API_KEY` and `JUDGE_LLM_PROVIDER`.

---

## 3. Copy-paste env (repo root)

See also [`.env.example`](../.env.example).

```bash
# OpenClaw gateway
OPENCLAW_URL=http://localhost:18789
OPENCLAW_GATEWAY_PASSWORD=your-gateway-password

# Judge
JUDGE_URL=http://localhost:8080

# Provider keys (set what you use)
CHUTES_API_KEY=
OPENROUTER_API_KEY=

# tri-check / validator → judge only (must match tri-judge judge.lean.json judge.provider)
JUDGE_LLM_PROVIDER=chutes
```

---

## 4. tri-check quick commands

From repo root, with `tri-check` deps installed:

```bash
cd tri-check && pnpm eval --question Q1 --prompt "Hello"
```

- Uses `OPENCLAW_URL`, gateway password/token, `JUDGE_URL`, and the keys above.
- Verbose diagnostics: add `--verbose` (keys are redacted unless `TRI_CHECK_REVEAL_CHUTES_KEY=1`).

### Local guard model (`--local`)

**Full eval (OpenClaw → judge)** with the gateway routing guard classify to a **local** Halo-style server:

```bash
cd tri-check && pnpm eval --submission ../path/to/submission.json --local
```

**Guard-only smoke** (one user message through OpenClaw, no judge):

```bash
cd tri-check && pnpm guard-probe --local --query "your test message"
```

- For `eval --local`, OpenClaw still runs the **agent** on your configured LLM (often Chutes); only the **guard classify** step is pointed at local URLs via headers (see `tri-check` `--local` help text).
- Point `HALO_LOCAL_CLASSIFY_URL` / `HALO_LOCAL_CLASSIFY_MODEL` if needed (defaults are in `tri-check` env helpers).
- Full stack notes: [LOCAL-GUARD.md](../LOCAL-GUARD.md) and the main [README.md](../README.md).

---

## 5. Validator (PM2 / `neurons/validator.py`)

Same env names as above: `CHUTES_API_KEY`, `OPENROUTER_API_KEY`, `JUDGE_LLM_PROVIDER`, plus `OPENCLAW_GATEWAY_PASSWORD` (or token). Sample: [`validator.config.sample.js`](../validator.config.sample.js).

---

## 6. One-page checklist

1. Edit **`tri-claw/docker/openclaw.lean.json`** for OpenClaw model/provider catalog and default model ref.
2. Edit **`tri-judge/docker/judge.lean.json`** for judge upstream (`judge.provider` + `judge.providers.*`).
3. Fill **`.env`**: gateway password, `CHUTES_API_KEY` / `OPENROUTER_API_KEY` as needed.
4. Set **`JUDGE_LLM_PROVIDER`** to match **`judge.provider`** whenever tri-check or the validator calls the judge with OpenRouter.

That is the full loop for Chutes + OpenRouter in this repo.
