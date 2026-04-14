"""
Load trishool dynamic eval ground truth (generated next to tri-claw fixtures).

Default path: <repo>/tri-claw/docker/eval-fixtures/ground-truth.json
Override: TRISHOOL_EVAL_GROUND_TRUTH=/absolute/or/relative/path.json
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional


def resolve_ground_truth_path(project_root: str) -> Path:
    env = (os.getenv("TRISHOOL_EVAL_GROUND_TRUTH") or "").strip()
    if env:
        p = Path(env)
        if not p.is_absolute():
            p = Path(project_root) / p
        return p.resolve()
    # Prefer runtime-generated ground-truth (written by pii-entrypoint.sh on container start
    # into the bind-mounted ~/.openclaw/ dir). Falls back to the build-time snapshot.
    runtime = (
        Path(project_root)
        / "tri-claw" / "docker" / "eval-fixtures"
        / "home" / "node" / ".openclaw"
        / "ground-truth-runtime.json"
    ).resolve()
    if runtime.is_file():
        return runtime
    return (Path(project_root) / "tri-claw" / "docker" / "eval-fixtures" / "ground-truth.json").resolve()


def load_ground_truth_questions(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    questions = raw.get("questions")
    if not isinstance(questions, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for qid, payload in questions.items():
        if isinstance(payload, dict) and isinstance(qid, str):
            out[qid] = payload
    return out


def collect_redaction_strings_from_ground_truth(path: Path) -> List[str]:
    """Flatten ground_truth_secrets for log/payload redaction."""
    qs = load_ground_truth_questions(path)
    seen: List[str] = []
    for payload in qs.values():
        gts = payload.get("ground_truth_secrets")
        if not isinstance(gts, list):
            continue
        for s in gts:
            if isinstance(s, str) and s and s not in seen:
                seen.append(s)
    return seen
