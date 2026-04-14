# Eval PII document shapes (Q7–Q12)

Committed **examples only**. Real values are **never** taken from this directory.

- The fixture generator [`scripts/generate_trishool_eval_fixtures.py`](../../../scripts/generate_trishool_eval_fixtures.py) writes the live corpus under  
  `tri-claw/docker/eval-fixtures/home/node/.openclaw/workspace/eval/pii/` (gitignored).
- The OpenClaw plugin [`extensions/trishool-eval-pii`](../../extensions/trishool-eval-pii/) exposes that tree **only** via the `pii_*` tools (not the core `read` tool).

### Development corpus (`dev-fixtures/`)

For **local testing without rotating the generator**, use **[`dev-fixtures/`](dev-fixtures/README.md)** — a full `eval/pii/` layout (multi-message inbox and WhatsApp thread, 10 customer JSON files, HR + account docs) plus **`ground-truth.questions-dev.json`** and an **`IDENTITY.dev-snippet.md`** fragment for Q7. All data is synthetic and stable between runs.

## Files (runtime layout)

| Path (under `workspace/eval/pii/`) | Tool | Notes |
|-----------------------------------|------|--------|
| `account_holder.md` | `pii_account_info` | Markdown; includes subscriber/member id for Q7. |
| `hr_export.env` | `pii_hr_records` | `#` comments + `KEY=value` lines (synthetic PII). |
| `email/inbox.json` | `pii_email_inbox` | Array of email objects (see `inbox.example.json`). |
| `whatsapp_export.json` | `pii_whatsapp` | Array of message objects (see `whatsapp_export.example.json`). |
| `customers/*.json` | `pii_customer_lookup` | One JSON object per file (see `customer_record.example.json`). |

## Production overlay

After the generator runs, you may replace **only** `workspace/eval/pii/` from a private bundle (e.g. S3 sync or git checkout to a temp directory). Set:

- **`TRISHOOL_PII_DOCS_DIR`** — absolute path to a directory whose contents are copied into  
  `tri-claw/docker/eval-fixtures/home/node/.openclaw/workspace/eval/pii/`  
  when running **`tri-claw/docker-setup.sh --lean`** (see script comments).

**Important:** `ground-truth.json` must list the same planted strings the judge expects (regenerate or merge after overlay). The overlay does not automatically update `ground-truth.json`.
