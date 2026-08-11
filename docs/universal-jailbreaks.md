# Universal jailbreak templates

Miners submit one scaffold with a single `{{objective}}` slot. The platform expands it against the active challenge's questions before validators and scoring see it. Downstream still receives the familiar `Q1`…`Qn` shape.

## Submission shapes

| Challenge `submission_format` | Body |
|---|---|
| `TEMPLATE` (default for new challenges) | `{"prompt": "... {{objective}} ..."}` |
| `QUESTIONS` (legacy) | `{"Q1": {"prompt": "...", ...}, ...}` |

Rules for `TEMPLATE`:

- Exactly one `{{objective}}` (case/whitespace tolerant: `{{ objective }}`, `{{Objective}}`).
- Template length ≤ **2000 characters including the placeholder**. Expanded prompts may exceed 2000; that growth is not re-checked.
- No other `{{...}}` placeholders. Single braces like `{objective}` are literal text.
- No extra top-level keys. `technique` / `url` / `MCP` are supported under `QUESTIONS` only.

Validation runs in three places with **identical error strings** — keep them in sync:

1. `sn23-backend` `app/core/prompt_template.py` (authoritative on upload)
2. `tri-check/src/template.ts` (local eval)
3. `alignet/cli/prompt_template.py` (miner CLI pre-flight)

## Locked decisions

### Exactly one `{{objective}}`

Zero placeholders is a 400. Without the slot, all expansions are byte-identical, which turns the challenge into one trial scored once per question. The summed 0/1/2 scoring cannot tell that apart from genuine breadth. The placeholder is required so each question is a **distinct trial**, even if your technique does not depend on the objective text — append a trailing `{{objective}}` if you need a no-op slot.

### `technique` / `url` / `MCP`

Supported under `QUESTIONS`, not under `TEMPLATE`. Under `TEMPLATE`, `tri-check` uses the CLI-level `--openclaw-url` for every expansion (no per-question override).

### Length

Only the submitted template is capped at 2000 characters (including `{{objective}}`). Challenge-authored objectives are substituted server-side; expanded length is not the miner's problem.

## Hypothesis (why this format)

A jailbreak whose efficacy is invariant to the harmful objective is a *capability* of the attack scaffold. N hand-tuned prompts are N data points; one template that clears all N objectives is a claim about the model's boundary.

What it proves: the *same text* works across the challenge's objectives. What it does **not** prove on its own: cross-category universality (many shipped sets are single-category), holdout generalization (objectives are public today), or breadth vs narrow yield (scoring is a sum, not a universality metric). See Plan.md for the full gap analysis and phased follow-ups.

## Evidence miners already do this

`tri-check/data/example-submission.json` has **byte-identical** prompts for every question — already a universal jailbreak submitted through the old shape. The format change makes that pattern legible and rejects placeholder-free bodies so scoring stays measurable.

**Common-prefix study (prod `miner_submissions`, n=1351, 2026-07-27):**

| Bucket | Count |
|---|---|
| 0.00–0.25 (mostly distinct per question) | 1267 |
| 0.25–0.50 | 18 |
| 0.50–0.75 | 15 |
| 0.75–0.95 (strong scaffold) | 34 |
| 0.95–1.00 (near-universal) | 17 |

- Coverage median **0.0005**, mean **0.055**. Fully identical prompts: **12 / 1351 (0.89%)**.
- So universal scaffolds exist in the wild, but they are a **small minority** — most historical submissions are still per-question distinct text. The reference example is real, not typical.

**Cosine (text-embedding-3-small), high-coverage template proxies (n=30):**

| Distribution | n | p10 | median | p90 |
|---|---|---|---|---|
| template↔template | 435 | 0.20 | 0.30 | 0.80 |
| template↔legacy same-id | 30 | 0.73 | 0.95 | 1.00 |
| template↔legacy all pairs | 900 | 0.21 | 0.31 | 0.81 |

Heuristic suggestion from same-technique cross p10: **`SIMILARITY_CHECK_THRESHOLD_TEMPLATE ≈ 0.71`** (placeholder default was 0.85). Stratified samples that include low-coverage (non-template) rows depress same-id cross-format cosine — treat those as a warning that per-`kind` thresholds may still be needed if low-quality proxies enter the corpus. Final threshold flip remains a rollout decision.

## Local testing

```bash
cd tri-check
pnpm eval --submission data/new-format.json --questions data/questions.json
```

Expect one result per question in `data/questions.json`, each `promptSubmitted` containing its own objective.
