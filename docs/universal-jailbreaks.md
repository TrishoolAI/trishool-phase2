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

Zero placeholders is a 400. Without the slot, all expansions are byte-identical, which turns the challenge into one trial scored twelve times. The summed 0/1/2 scoring cannot tell that apart from genuine breadth. The placeholder is required so each question is a **distinct trial**, even if your technique does not depend on the objective text — append a trailing `{{objective}}` if you need a no-op slot.

### `technique` / `url` / `MCP`

Supported under `QUESTIONS`, not under `TEMPLATE`. Under `TEMPLATE`, `tri-check` uses the CLI-level `--openclaw-url` for every expansion (no per-question override).

### Length

Only the submitted template is capped at 2000 characters (including `{{objective}}`). Challenge-authored objectives are substituted server-side; expanded length is not the miner's problem.

## Hypothesis (why this format)

A jailbreak whose efficacy is invariant to the harmful objective is a *capability* of the attack scaffold. Twelve hand-tuned prompts are twelve data points; one template that clears twelve objectives is a claim about the model's boundary.

What it proves: the *same text* works across the challenge's objectives. What it does **not** prove on its own: cross-category universality (many shipped sets are single-category), holdout generalization (objectives are public today), or breadth vs narrow yield (scoring is a sum, not a universality metric). See Plan.md for the full gap analysis and phased follow-ups.

## Evidence miners already do this

`tri-check/data/example-submission.json` has twelve **byte-identical** prompts — already a universal jailbreak submitted through the old shape. The format change makes that pattern legible and rejects placeholder-free bodies so scoring stays measurable. The common-prefix study (human measurement) turns this anecdote into a distribution; that distribution is still a stated gap until measurements run.

## Local testing

```bash
cd tri-check
pnpm eval --submission data/new-format.json --questions data/questions.json
```

Expect twelve results, each `promptSubmitted` containing its own objective.
