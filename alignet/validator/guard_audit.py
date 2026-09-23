"""Copy OpenClaw guard decisions into the existing judge `deobfuscatedPrompt` string."""

import json
from typing import Any

_NO_GUARD_AUDIT = json.dumps(
    {
        "input": {"ran": False, "skipped": "no_guard_audit"},
        "output": {"ran": False, "skipped": "no_guard_audit"},
    },
    separators=(",", ":"),
)


def guard_audit_deobfuscated_prompt(openclaw_output: Any) -> str:
    """
    Guard decisions travel on OpenClaw's chat-completion JSON as `deobfuscatedPrompt`.
    When that field is missing, report that the guard audit never arrived.
    """
    if isinstance(openclaw_output, dict):
        raw = openclaw_output.get("deobfuscatedPrompt")
        if isinstance(raw, str) and raw.strip():
            return raw
    return _NO_GUARD_AUDIT
