from __future__ import annotations

import re
import threading
import time
import uuid
from typing import Any

DEFAULT_GUARD_SYSTEM_PROMPT = (
    "Output ONLY in this format:\n"
    "Safety: [safe/controversial/unsafe]\n"
    "Category: [primary category or none]\n"
    "AttackOverlay: [none/jailbreak/prompt_injection]"
)


class ServerState:
    def __init__(
        self,
        model: Any,
        tokenizer: Any,
        device: str,
        max_length: int,
        max_new_tokens: int,
        system_prompt: str | None = None,
        adapter_path: str | None = None,
        model_id: str | None = None,
        model_revision: str | None = None,
    ) -> None:
        self.model = model
        self.tokenizer = tokenizer
        self.device = device
        self.max_length = max_length
        self.max_new_tokens = max_new_tokens
        self.system_prompt = system_prompt
        self.adapter_path = adapter_path
        self.model_id = model_id
        self.model_revision = model_revision
        self.lock = threading.Lock()


def resolve_device(device: str) -> str:
    import torch
    if device != "auto":
        return device
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def resolve_dtype(dtype: str, device: str) -> Any:
    import torch

    if dtype == "float16":
        return torch.float16
    if dtype == "bfloat16":
        return torch.bfloat16
    if dtype == "float32":
        return torch.float32
    if device.startswith("cuda"):
        return torch.bfloat16
    if device == "mps":
        return torch.float16
    return torch.float32


def build_messages(system_prompt: str | None, user_message: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt or DEFAULT_GUARD_SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]


def extract_user_message(payload: dict[str, Any]) -> str:
    query = payload.get("query")
    if query:
        return str(query)

    messages = payload.get("messages", [])
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("content", ""))
    return ""


def _canonical_safety_label(value: str | None) -> str:
    if not value:
        return "Unknown"
    normalized = value.strip().lower()
    mapping = {
        "safe": "Safe",
        "sensitive": "Sensitive",
        "unsafe": "Unsafe",
        "controversial": "Controversial",
    }
    return mapping.get(normalized, value.strip())


def _canonical_category(value: str | None) -> str:
    if not value:
        return "none"
    cleaned = value.strip()
    if cleaned.lower() == "none":
        return "none"
    return cleaned


def _canonical_attack_overlay(value: str | None) -> str:
    if not value:
        return "none"
    normalized = value.strip().lower()
    if normalized in {"none", "jailbreak", "prompt_injection"}:
        return normalized
    return normalized


def _normalize_generated_text(safety_label: str | None, category: str, attack_overlay: str) -> str:
    safety_text = (safety_label or "Unknown").lower()
    return (
        f"Safety: {safety_text}\n"
        f"Category: {category}\n"
        f"AttackOverlay: {attack_overlay}"
    )


def extract_label_and_categories(content: str) -> tuple[str | None, list[str], str]:
    safety_match = re.search(
        r"^Safety:\s*(Safe|Sensitive|Unsafe|Controversial)\s*$",
        content,
        re.IGNORECASE | re.MULTILINE,
    )
    category_match = re.search(r"^Category:\s*(.+?)\s*$", content, re.IGNORECASE | re.MULTILINE)
    overlay_match = re.search(
        r"^AttackOverlay:\s*(.+?)\s*$",
        content,
        re.IGNORECASE | re.MULTILINE,
    )

    safety = _canonical_safety_label(safety_match.group(1) if safety_match else None)
    category = _canonical_category(category_match.group(1) if category_match else None)
    attack_overlay = _canonical_attack_overlay(overlay_match.group(1) if overlay_match else None)
    return safety, [category], attack_overlay


def _classify_safety(safety_label: str | None) -> str:
    if safety_label == "Unsafe":
        return "HARMFUL"
    if safety_label == "Sensitive":
        return "SENSITIVE"
    if safety_label == "Controversial":
        return "CONTROVERSIAL"
    return "HARMLESS"


def _safety_token_ids(tokenizer: Any) -> dict[str, list[int]]:
    candidates = {
        "safe": ["safe", "Safe", " safe", " Safe"],
        "unsafe": ["unsafe", "Unsafe", " unsafe", " Unsafe"],
        "controversial": ["controversial", "Controversial", " controversial", " Controversial"],
    }
    result: dict[str, list[int]] = {}
    for tier, strings in candidates.items():
        ids: list[int] = []
        for value in strings:
            encoded = tokenizer.encode(value, add_special_tokens=False)
            if encoded:
                ids.append(encoded[0])
        result[tier] = list(set(ids))
    return result


def _safety_probs_from_logits(logits: Any, token_ids: dict[str, list[int]]) -> dict[str, float]:
    import torch
    probs = torch.nn.functional.softmax(logits, dim=-1)
    result: dict[str, float] = {}
    for tier, ids in token_ids.items():
        result[tier] = float(sum(probs[token_id].item() for token_id in ids if token_id < probs.shape[0]))
    total = sum(result.values()) or 1.0
    return {tier: value / total for tier, value in result.items()}


def classify_query(state: ServerState, user_message: str) -> dict[str, Any]:
    import torch
    tokenizer = state.tokenizer
    model = state.model

    messages = build_messages(state.system_prompt, user_message)
    rendered = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    rendered_with_prefix = rendered + "Safety: "
    model_inputs = tokenizer(
        rendered_with_prefix,
        return_tensors="pt",
        truncation=True,
        max_length=state.max_length,
    ).to(state.device)

    with state.lock, torch.inference_mode():
        outputs = model(**model_inputs)
        safety_logits = outputs.logits[0, -1, :]
        tier_probs = _safety_probs_from_logits(safety_logits, _safety_token_ids(tokenizer))
        generated_ids = model.generate(
            **model_inputs,
            max_new_tokens=state.max_new_tokens,
            do_sample=False,
            pad_token_id=getattr(tokenizer, "pad_token_id", None) or getattr(tokenizer, "eos_token_id", None),
        )

    prompt_length = len(model_inputs["input_ids"][0])
    output_ids = generated_ids[0][prompt_length:]
    if hasattr(output_ids, "tolist"):
        output_ids = output_ids.tolist()
    generated_text = ("Safety: " + tokenizer.decode(output_ids, skip_special_tokens=True)).strip()

    best_tier = max(tier_probs, key=lambda tier: tier_probs[tier])
    _, categories, attack_overlay = extract_label_and_categories(generated_text)
    safety_label = _canonical_safety_label(best_tier)
    normalized_text = _normalize_generated_text(
        safety_label,
        categories[0] if categories else "none",
        attack_overlay,
    )

    return {
        "status": _classify_safety(safety_label),
        "safety_label": safety_label,
        "category": categories[0] if categories else "none",
        "attack_overlay": attack_overlay,
        "confidence": round(tier_probs[best_tier], 4),
        "tier_probs": {key: round(value, 4) for key, value in tier_probs.items()},
        "generated_text": normalized_text,
        "tier": safety_label if safety_label else "Unknown",
    }


def build_chat_completion_response(result: dict[str, Any], model_name: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": result["generated_text"]},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "classification": result,
    }


def load_guard_model(
    model_path: str,
    *,
    adapter_path: str | None = None,
    device: str,
    torch_dtype: Any,
    local_files_only: bool = True,
    model_revision: str | None = None,
) -> tuple[Any, Any]:
    from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration
    common_kwargs: dict[str, Any] = {
        "trust_remote_code": True,
        "local_files_only": local_files_only,
    }
    if model_revision is not None:
        common_kwargs["revision"] = model_revision

    tokenizer = AutoTokenizer.from_pretrained(model_path, **common_kwargs)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        model_path,
        torch_dtype=torch_dtype,
        **common_kwargs,
    )

    if adapter_path:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter_path, local_files_only=local_files_only)

    model.eval()
    if device != "cpu":
        model.to(device)

    return model, tokenizer
