"""
Universal jailbreak template validation for the miner CLI.

Rules and every error string here are mirrored in two other places and must
stay byte-identical:

    - app/core/prompt_template.py   (sn23-backend, authoritative on upload)
    - tri-check/src/template.ts     (local miner evaluation)

Divergence between the three is what produces "it passed locally but the upload
was rejected", so change all three together or none.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

PLACEHOLDER_NAME = "objective"

PLACEHOLDER_RE = re.compile(r"\{\{\s*objective\s*\}\}", re.IGNORECASE)
ANY_PLACEHOLDER_RE = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)

PROMPT_MAX_LEN = 2000


class TemplateValidationError(ValueError):
    """Raised for any malformed template. The message is shown to the miner."""


def extract_template(submission_items: Any) -> str:
    if not isinstance(submission_items, dict):
        raise TemplateValidationError("Submission items must be a JSON object")

    if not submission_items:
        raise TemplateValidationError(
            'Submission items must be a JSON object of the form {"prompt": "<text>"}'
        )

    keys = set(submission_items.keys())

    if "prompt" not in keys and any(re.fullmatch(r"[Qq]\d+", k) for k in keys):
        raise TemplateValidationError(
            "This challenge expects the universal template format "
            '{"prompt": "... {{objective}} ..."}, not per-question Q1..Qn items. '
            "See docs/universal-jailbreaks.md"
        )

    extra = sorted(keys - {"prompt"})
    if extra:
        raise TemplateValidationError(
            f"unsupported top-level key(s) {', '.join(extra)} — the template "
            'body must contain only "prompt"'
        )

    prompt = submission_items.get("prompt")
    if not isinstance(prompt, str):
        raise TemplateValidationError("prompt must be a non-empty string")

    return prompt


def validate_template(template: str, *, max_len: int = PROMPT_MAX_LEN) -> None:
    if not isinstance(template, str) or not template.strip():
        raise TemplateValidationError("prompt must be a non-empty string")

    if len(template) > max_len:
        raise TemplateValidationError(
            f"prompt exceeds maximum length {max_len} characters "
            f"(got {len(template)})"
        )

    for match in ANY_PLACEHOLDER_RE.finditer(template):
        if not PLACEHOLDER_RE.fullmatch(match.group(0)):
            raise TemplateValidationError(
                f"unsupported placeholder {match.group(0)} — only "
                "{{objective}} is allowed (single braces are literal text)"
            )

    found = len(PLACEHOLDER_RE.findall(template))
    if found == 0:
        raise TemplateValidationError(
            "template must contain the {{objective}} placeholder exactly once "
            "(found none) — the placeholder is required so that each question "
            "is a distinct trial, even if your technique does not depend on "
            "the objective text"
        )
    if found > 1:
        raise TemplateValidationError(
            "template must contain the {{objective}} placeholder exactly once "
            f"(found {found})"
        )


def is_template_submission(submission_items: Any) -> bool:
    """True when the body looks like {"prompt": "..."} with no Q* keys."""
    if not isinstance(submission_items, dict) or not submission_items:
        return False
    keys = set(submission_items.keys())
    if any(re.fullmatch(r"[Qq]\d+", k) for k in keys):
        return False
    return "prompt" in keys


def expand_template(
    template: str,
    questions: List[Dict[str, Any]],
) -> Dict[str, Dict[str, str]]:
    if not questions:
        raise TemplateValidationError("Active challenge has no questions configured")

    expanded: Dict[str, Dict[str, str]] = {}
    for question in questions:
        question_id = question.get("question_id")
        if not isinstance(question_id, str) or not question_id:
            raise TemplateValidationError(
                "Active challenge has a question with no question_id"
            )
        objective = question.get("objective")
        if not isinstance(objective, str) or not objective.strip():
            raise TemplateValidationError(
                f"Active challenge question {question_id} has no objective text"
            )
        prompt = PLACEHOLDER_RE.sub(lambda _match: objective, template, count=1)
        expanded[question_id] = {"prompt": prompt}
    return expanded
