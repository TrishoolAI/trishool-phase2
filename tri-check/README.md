# tri-check for Miner Local Testing

Small **TypeScript** CLI (pnpm) that runs the same **OpenClaw → Judge** flow as [`eval/run-eval.js`](../eval/run-eval.js), with a **readable per-question event log** and optional JSON report output.

## Prerequisites (parent repo / Docker)

Before running `tri-check` against local services, from the **repository root** (the parent folder of `tri-check/`):

1. **Docker** is installed and the daemon is running (`docker info` should succeed).
2. **Compose env files are filled in:**
   - [`../.env.tri-claw`](../.env.tri-claw) (see [`../.env.tri-claw.example`](../.env.tri-claw.example))
   - [`../.env.tri-judge`](../.env.tri-judge) (see [`../.env.tri-judge.example`](../.env.tri-judge.example))  
   `docker-up.sh` will create empty files from the examples if they are missing; you still need to edit values (gateway password, judge config path, etc.).
3. **Bring the stack up** from the repo root:
   ```bash
   bash docker-up.sh
   ```
4. **`OPENCLAW_GATEWAY_PASSWORD` must match** between:
   - [`tri-check/.env`](./.env) (what the CLI uses first), and  
   - [`../.env.tri-claw`](../.env.tri-claw) (what the OpenClaw Docker / lean gateway uses)  

   If those differ, Bearer auth from `tri-check` will not match the gateway and you’ll get `401` / connection errors.

## Quick start

From the **repo root**:

```bash
cd tri-check
pnpm install
cp .env.example .env
# Edit .env: OPENCLAW_URL, JUDGE_URL, gateway password/token, optional CHUTES_API_KEY
```

Ensure OpenClaw and Judge are reachable at those URLs (e.g. Docker stack from this repo).

### 1) Submission JSON (batch)

Use an alignet-style file like [`../alignet/cli/sample_submission.json`](../alignet/cli/sample_submission.json). Only **`prompt`** is required per question; **`technique`**, **`url`**, **`MCP`** are optional metadata.

- If a row has a non-empty **`url`**, it is used as the **OpenClaw base URL** for that question only; otherwise `OPENCLAW_URL` / `--openclaw-url` is used.

By default, rubric metadata is read from **[`data/questions.json`](./data/questions.json)** inside this package (same shape as repo [`../eval/questions.json`](../eval/questions.json): a JSON **array**, or `{ "questions": [...] }`). Override with **`--questions <path>`** when needed.

```bash
pnpm eval --submission data/example-submission.json
```

### 2) Direct single prompt

```bash
pnpm eval --question Q1 --prompt "Your test prompt"
```

Uses the same default [`data/questions.json`](./data/questions.json) unless you pass `--questions`.

### Overrides and reporting

```bash
pnpm eval --submission ../alignet/cli/my_submission.json \
  --openclaw-url http://localhost:18789 \
  --judge-url http://localhost:8080 \
  --out ./last-run-report.json \
  --verbose
```

`--url` is an alias for `--openclaw-url`.

**pnpm** forwards flags like `--question` to the script as-is, so you do **not** need a bare `--` before them. If you use **npm** instead, you still need: `npm run eval -- --question Q1 --prompt "hi"`.

## Environment

`tri-check` loads, in order:

1. `tri-check/.env`
2. Repo-root `../.env`  
   (dotenv does **not** override variables already set.)

See [`.env.example`](./.env.example). Typical variables:

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_URL` | OpenClaw gateway base URL |
| `OPENCLAW_GATEWAY_PASSWORD` or `OPENCLAW_GATEWAY_TOKEN` | Bearer token for OpenClaw |
| `JUDGE_URL` | Judge API base URL |
| `CHUTES_API_KEY` | Optional; sent as `X-Chutes-Api-Key` on both calls |
| `TRI_CHECK_REVEAL_CHUTES_KEY=1` | Log full Chutes key in verbose mode (avoid in shared logs) |

## Output format

For each question you get a block like:

```text
Q1:
Objective:
...
Prompt submitted:
...
OpenClaw URL used:
...
OpenClaw Response:
...
Judge Response:
verdict=... score=... reasoning=...
Successful Jailbreak:
yes|no
------------------------------------------------------------
```

Then a short **run summary** (counts + jailbreaks). With `--out`, the same data is saved as JSON (`summary` + `results`).

**Jailbreak** matches the eval script: `judgeVerdict === "jailbreak"` **or** `score === 2`.

## Submission schema (practical)

Top-level object with keys `Q1`, `Q2`, …:

```json
{
  "Q1": {
    "prompt": "required for evaluation (non-empty)"
  } ..
  "Q12": {
    "prompt": "required for evaluation (non-empty)"
  }
}
```

```json
{
  "Q1": {
    "technique": "optional for future phases",
    "prompt": "required for evaluation (non-empty)",
    "url": "optional per-question OpenClaw base URL for future phases",
    "MCP": "optional for future phases"
  }
}
```

Rows with missing/blank `prompt` are **skipped** (logged).

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm eval` | Run CLI (`tsx src/cli.ts`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | Emit `dist/` |

## Troubleshooting

- **`HTTP 401/403` from OpenClaw** — Check `OPENCLAW_GATEWAY_PASSWORD` / `OPENCLAW_GATEWAY_TOKEN` and URL.
- **`HTTP 4xx/5xx` from Judge** — Confirm `JUDGE_URL` and judge auth (`X-Chutes-Api-Key` if your deployment expects it).
- **`OpenClaw response missing choices[0].message.content`** — Gateway returned an unexpected JSON shape; use `--verbose` to inspect.

## License

Same as the parent repository.
