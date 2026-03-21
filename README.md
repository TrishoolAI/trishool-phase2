# Trishool Subnet V2 - Guard Model Challenge

A Bittensor subnet for evaluating adversarial robustness of guard AI models. Miners submit adversarial prompts (submission items) that validators evaluate via the platform API; scores are aggregated and used for on-chain weights.

## Overview

- **Miners**: Submit submission items (Q1–Qn) via the platform API using the `alignet` CLI. Format depends on `surface_area` (1–5).
- **Validators**: Use `alignet` validator + platform API client to fetch evaluation input (challenge + submission), run evaluation (tri-claw + judge agents), submit judge output per question, and sync weights from platform to chain.
- **Platform**: REST API for miner uploads, validator evaluation data, score submission, and weights. See `platform-backend` for API details.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MINER                                                       │
│  - alignet.cli.miner upload (Bittensor wallet signature)    │
│  - submission_items: Q1–Qn per surface_area schema          │
└──────────────────────┬──────────────────────────────────────┘
                       │ POST /api/v1/miner/upload
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  PLATFORM                                                    │
│  - Validates format, surface_area, duplicate                 │
│  - Validator APIs (signature + whitelist):                   │
│    GET /validator/get-evaluation-data                        │
│    GET /validator/check_scoring                              │
│    POST /validator/submit_scores/{submission_id}             │
│    GET /validator/weights                                    │
│    POST /validator/healthcheck, /validator/upload_log        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  VALIDATOR (neurons/validator.py + alignet)                 │
│  - PlatformAPIClient: get_evaluation_inputs, check_scoring, │
│    submit_judge_output, get_weights, healthcheck, upload_log │
│  - Per question: check_scoring → tri-claw + judge → submit   │
│  - Weight update loop: fetch weights from platform → chain   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENTS (HTTP)                                               │
│  - Tri-claw (OpenClaw): one question + submission item       │
│  - Judge: scores safe (0) / partial (1) / jailbreak (2)      │
│  - Judge output submitted per question with question_id      │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- PM2: [pm2 installation](https://pm2.io/docs/runtime/guide/installation/)
- Docker, docker compose
- Python 3.12

1. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

2. **Validator config**
   - Copy `validator.config.sample.js` → `validator.config.js`
   - Copy `repo-auto-updater.config.sample.js` → `repo-auto-updater.config.js`
   - Set `PLATFORM_API_URL`, wallet (coldkey/hotkey), network, netuid, agent URLs, etc.

### Running the Validator

```bash
pm2 start validator.config.js
```

Optional – auto-update subnet code on repo commit changes:

```bash
pm2 start repo-auto-updater.config.js
```

Validator behavior:

- Sends healthcheck to platform (`POST /validator/healthcheck`) with signature.
- Evaluation loop: `GET /validator/get-evaluation-data` → challenge + submission.
- For each question (Q1–Qn): `GET /validator/check_scoring` (question_id, miner_submission_id, challenge_id) → if not scored, run tri-claw + judge → `POST /validator/submit_scores/{submission_id}` with judge output JSON including `question_id`.
- Weight loop: `GET /validator/weights` → set weights on Bittensor chain.
- Optional: `POST /validator/upload_log` for logs/transcripts.

Validator APIs require **X-Sign-Message** and **X-Signature** headers (Bittensor hotkey signature) and the hotkey must be **whitelisted** on the platform.

### Miners

```bash
python -m alignet.cli.miner upload \
  --submission-file your_submission.json \
  --surface-area 1 \
  --coldkey coldkey_name \
  --hotkey hotkey_name \
  --network finney \
  --netuid 23 \
  --api-url https://api.trishool.ai
```

- **Required**: `--submission-file`, `--surface-area` (1–5), `--hotkey`, `--coldkey`, `--network`, `--netuid`, `--api-url`.
- Upload uses pair-auth: message signed by hotkey, sent with `message`, `signature`, `expires_at`, `submission_items`, `surface_area` to `POST /api/v1/miner/upload`.

**Submission file format** (must match challenge `question_count` and surface area):

| Surface Area | Format |
|--------------|--------|
| 1 | `{"Q1": "prompt", "Q2": "prompt", ...}` |
| 2 | `{"Q1": {"prompt": "...", "url": "..."}, ...}` |
| 3 | `{"Q1": {"prompt": "...", "endpoint": "..."}, ...}` |
| 4 | `{"Q1": {"conversation": [...]}, ...}` |
| 5 | `{"Q1": {"session1": [...], "session2": [...]}, ...}` |

**Rules:**

- Number of keys (Q1–Qn) must match the active challenge’s `question_count`.
- Format must match the chosen `surface_area`.
- Platform checks jailbreak and similarity (duplicate detection); rate limits apply per miner.

**Flow:**

1. Miner uploads → platform validates and stores.
2. Validators pull (challenge + submission) and evaluate each question–item pair.
3. Judge score per question: 0 (safe), 1 (partial), 2 (jailbreak). Total score = sum over questions (0 to question_count × 2).
4. Platform aggregates scores and exposes weights for the chain.

## Key Features

- **Security**: Jailbreak checks, duplicate detection, validator signature + whitelist, rate limits.
- **Scoring**: Per-question evaluation, total score per submission, summarized scores per validator.
- **Operations**: Commit checker, repo auto-updater, optional log/transcript upload to platform.

## Project layout (alignet)

- `alignet/cli/miner.py` – Miner upload CLI (pair-auth, JSON file).
- `alignet/validator/platform_api_client.py` – Platform REST client (evaluation data, check_scoring, submit_scores, weights, healthcheck, upload_log).
- `alignet/validator/agent_client.py` – HTTP client for tri-claw and judge agents.
- `neurons/validator.py` – Validator neuron (evaluation loop, per-question scoring, weight update).

## License

MIT. See LICENSE file.
