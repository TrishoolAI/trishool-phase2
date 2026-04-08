#!/usr/bin/env python3
"""
Local HTTP server for Halo-style guard classify (OpenClaw guard-model / tri-check).

Default model: astroware/Halo0.8B-guard-v1 (Qwen3.5, ~0.8B).

Endpoints:
  POST /v1/classify   — JSON body must include `query`; use `role`: \"input\" | \"output\" (OpenClaw/Chutes parity).
  POST /v1/chat/completions
  GET  /health

Requires: pip install torch transformers accelerate
(For Qwen3.5 you may need a recent transformers release; upgrade if load fails.)

Run from anywhere; uses Hugging Face Hub unless --local-files-only.

Download progress: tqdm normally hides when stderr is not a TTY (e.g. nohup → log file).
This script sets TQDM_POSITION=-1 (Hub) and a Transformers tqdm hook so byte/shard progress
still appears in logs. Set HALO_GUARD_QUIET_DOWNLOAD=1 to disable that (smaller logs).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import warnings
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Force unbuffered stdout/stderr so logs appear immediately under nohup.
os.environ.setdefault("PYTHONUNBUFFERED", "1")

# Hugging Face "Xet" storage can repeatedly hit xet-read-token and never finish on some networks.
# Disable before importing transformers (pulls huggingface_hub.constants). Override with HF_HUB_DISABLE_XET=0.
if os.environ.get("HF_HUB_DISABLE_XET") is None:
    os.environ["HF_HUB_DISABLE_XET"] = "1"

# tqdm disables bars when stderr is not a TTY; Hub checks TQDM_POSITION==-1 to force bars (see huggingface_hub.utils.tqdm).
if os.environ.get("HALO_GUARD_QUIET_DOWNLOAD") != "1":
    os.environ.setdefault("TQDM_POSITION", "-1")

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
    stream=sys.stderr,
)
log = logging.getLogger("serve_halo_guard")
# Per-request "HTTP Request: HEAD …" lines are noisy; tqdm + our phase lines are enough for downloads.
logging.getLogger("httpx").setLevel(
    logging.INFO if os.environ.get("HALO_GUARD_VERBOSE_HTTP") == "1" else logging.WARNING
)

# -----------------------------------------------------------------------------
# Optional deps (clear errors if missing)
# -----------------------------------------------------------------------------

try:
    import torch
except ImportError as e:  # pragma: no cover
    raise SystemExit("serve_halo_guard: install PyTorch, e.g. pip install torch") from e

try:
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from transformers.utils import logging as transformers_utils_logging
except ImportError as e:  # pragma: no cover
    raise SystemExit("serve_halo_guard: pip install transformers accelerate") from e

# Transformers still passes torch_dtype internally in some paths (triggers a harmless warning).
for _cat in (UserWarning, FutureWarning):
    warnings.filterwarnings(
        "ignore",
        message=r".*`torch_dtype` is deprecated.*",
        category=_cat,
    )

if os.environ.get("HALO_GUARD_QUIET_DOWNLOAD") != "1":

    def _tqdm_logfile_hook(factory: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        kw = dict(kwargs)
        kw.setdefault("file", sys.stderr)
        if kw.get("disable") is None:
            kw["disable"] = False
        return factory(*args, **kw)

    transformers_utils_logging.set_tqdm_hook(_tqdm_logfile_hook)

try:
    from huggingface_hub import constants as _hf_constants
except Exception:  # pragma: no cover
    _hf_constants = None  # type: ignore[assignment]

log.info("Python executable: %s", sys.executable)
log.info("torch %s  |  transformers %s", torch.__version__, __import__("transformers").__version__)
if _hf_constants is not None:
    log.info(
        "Hub: HF_HUB_DISABLE_XET=%s (classic HTTP download; avoids stuck Xet on some networks)",
        _hf_constants.HF_HUB_DISABLE_XET,
    )
if os.environ.get("HALO_GUARD_QUIET_DOWNLOAD") != "1":
    log.info(
        "Download progress: tqdm lines go to this log (TQDM_POSITION=-1 + Transformers tqdm hook); "
        "HALO_GUARD_QUIET_DOWNLOAD=1 to silence."
    )
log.info(
    "What to expect: (1) tokenizer from Hub — usually under ~30s. "
    "(2) model.safetensors — first run downloads ~1–2GB; watch for tqdm lines or a multi-minute pause while data streams. "
    "(3) load into RAM/GPU — often another 1–3+ min on MPS/CPU. "
    "Success = log line 'Serving on http://…' then curl http://127.0.0.1:PORT/health returns JSON."
)


DEFAULT_MODEL_ID = "astroware/Halo0.8B-guard-v1"


def _heartbeat_until_event(
    message: str,
    stop: threading.Event,
    *,
    interval_sec: float = 30.0,
) -> None:
    """Log periodically so file logs do not look 'stuck' during large Hub downloads."""

    def _run() -> None:
        elapsed = 0.0
        while not stop.wait(timeout=interval_sec):
            elapsed += interval_sec
            log.info(
                "%s — still working (~%ds); large weight download often produces no HTTP lines until done",
                message,
                int(elapsed),
            )

    threading.Thread(target=_run, name="serve_halo_guard_heartbeat", daemon=True).start()


def _load_tokenizer(
    model_id: str,
    *,
    revision: str | None,
    local_files_only: bool,
    trust_remote_code: bool,
) -> Any:
    """
    Qwen3.x repos often set tokenizer_class=TokenizersBackend, which only exists in very new
    transformers. Fall back to PreTrainedTokenizerFast + tokenizer.json when AutoTokenizer fails.
    """
    tok_kw: dict[str, Any] = {
        "local_files_only": local_files_only,
        "trust_remote_code": trust_remote_code,
    }
    if revision is not None:
        tok_kw["revision"] = revision
    log.info("Trying AutoTokenizer.from_pretrained(%s) …", model_id)
    try:
        tok = AutoTokenizer.from_pretrained(model_id, **tok_kw)
        log.info("AutoTokenizer loaded successfully")
        return tok
    except (ValueError, OSError) as err:
        msg = str(err)
        if (
            "TokenizersBackend" not in msg
            and "does not exist" not in msg
            and "not currently imported" not in msg
        ):
            raise

    log.info("AutoTokenizer failed (%s); falling back to PreTrainedTokenizerFast", msg[:120])

    from huggingface_hub import hf_hub_download
    from transformers import PreTrainedTokenizerFast

    hub_kw: dict[str, Any] = {"local_files_only": local_files_only}
    if revision is not None:
        hub_kw["revision"] = revision

    if os.path.isdir(model_id):
        root = os.path.abspath(model_id)
        tok_json = os.path.join(root, "tokenizer.json")
        cfg_path = os.path.join(root, "tokenizer_config.json")
        if not os.path.isfile(tok_json):
            raise RuntimeError(
                f"AutoTokenizer failed ({msg}); no tokenizer.json under {model_id} for fallback."
            ) from err
        with open(cfg_path, encoding="utf-8") as f:
            tcfg = json.load(f)
        chat_jinja = os.path.join(root, "chat_template.jinja")
    else:
        try:
            log.info("Downloading tokenizer.json from Hub …")
            tok_json = hf_hub_download(repo_id=model_id, filename="tokenizer.json", **hub_kw)
            log.info("Downloading tokenizer_config.json from Hub …")
            cfg_path = hf_hub_download(repo_id=model_id, filename="tokenizer_config.json", **hub_kw)
        except Exception as e2:
            raise RuntimeError(
                "Could not load tokenizer (TokenizersBackend needs newer transformers, "
                "and tokenizer.json download failed). Try: pip install -U 'transformers>=4.51'"
            ) from e2
        with open(cfg_path, encoding="utf-8") as f:
            tcfg = json.load(f)
        chat_jinja = None
        try:
            log.info("Downloading chat_template.jinja from Hub …")
            chat_jinja = hf_hub_download(repo_id=model_id, filename="chat_template.jinja", **hub_kw)
        except Exception:
            log.info("No chat_template.jinja in repo; will use tokenizer_config.json template")
            pass

    special: dict[str, str] = {}
    for key in ("eos_token", "pad_token", "bos_token", "unk_token"):
        v = tcfg.get(key)
        if isinstance(v, str):
            special[key] = v

    tokenizer = PreTrainedTokenizerFast(tokenizer_file=tok_json, **special)

    if chat_jinja and os.path.isfile(str(chat_jinja)):
        with open(chat_jinja, encoding="utf-8") as f:
            tokenizer.chat_template = f.read()
    elif isinstance(tcfg.get("chat_template"), str):
        tokenizer.chat_template = tcfg["chat_template"]

    if getattr(tokenizer, "chat_template", None) is None:
        raise RuntimeError(
            "Tokenizer fallback loaded but chat_template is missing; add chat_template.jinja to the model "
            "or upgrade transformers so AutoTokenizer works."
        ) from err

    log.info("PreTrainedTokenizerFast fallback loaded (TokenizersBackend not in this transformers)")
    return tokenizer


def _resolve_torch_device(preferred: str) -> torch.device:
    p = (preferred or "auto").strip().lower()
    if p == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    return torch.device(p)


def _resolve_torch_dtype(name: str, device: torch.device) -> torch.dtype:
    n = (name or "auto").strip().lower()
    if n == "auto":
        if device.type == "cuda":
            return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        if device.type == "mps":
            return torch.float16
        return torch.float32
    if n in ("float16", "fp16"):
        return torch.float16
    if n in ("bfloat16", "bf16"):
        return torch.bfloat16
    return torch.float32


def _extract_user_message(body: dict[str, Any]) -> str | None:
    """OpenAI-style messages or Halo classify { query: str }."""
    if isinstance(body.get("query"), str) and body["query"].strip():
        return str(body["query"]).strip()
    messages = body.get("messages")
    if isinstance(messages, list):
        for m in reversed(messages):
            if not isinstance(m, dict):
                continue
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, str) and c.strip():
                return c.strip()
            if isinstance(c, list):
                parts: list[str] = []
                for block in c:
                    if isinstance(block, dict) and block.get("type") == "text":
                        t = block.get("text")
                        if isinstance(t, str):
                            parts.append(t)
                joined = "\n".join(parts).strip()
                if joined:
                    return joined
    return None


def _normalize_classify_role(body: dict[str, Any]) -> str | None:
    """OpenClaw `runChutesClassifyGuardCheck` sends `role`: \"input\" | \"output\" (see tri-claw guard-model)."""
    r = body.get("role")
    if not isinstance(r, str):
        return None
    s = r.strip().lower()
    if s in ("input", "output"):
        return s
    return None


def _apply_classify_role_to_user_text(user_text: str, role: str | None) -> str:
    """
    Hosted Halo /v1/classify uses `role` together with `query`. We previously dropped `role`, so OUTPUT
    checks saw the same framing as INPUT — same weights, wrong conditioning vs Chutes.
    Prefixes are explicit task tags so the model distinguishes user-side vs assistant-side evaluation.
    """
    if role == "input":
        return (
            "Guard phase: INPUT (user message). Classify the following for policy violations.\n\n"
            + user_text
        )
    if role == "output":
        return (
            "Guard phase: OUTPUT (assistant-generated text). Classify the following for leaks, "
            "jailbreak fulfillment, and harmful content.\n\n"
            + user_text
        )
    return user_text


def _parse_guard_lines(text: str) -> dict[str, Any]:
    """
    Map model completion to Halo /v1/classify JSON (OpenClaw parseChutesClassifyResponse).
    Expects lines like: Safety: ... / Category: ... / AttackOverlay: ... (tolerant).
    """
    raw = text.strip()
    safety_token = "unknown"
    m = re.search(r"(?im)^\s*Safety:\s*(.+?)\s*$", raw)
    if m:
        safety_token = m.group(1).strip()
    category = "none"
    m = re.search(r"(?im)^\s*Categories?:\s*(.+?)\s*$", raw)
    if m:
        category = m.group(1).strip()
    attack = "none"
    m = re.search(r"(?im)^\s*AttackOverlay:\s*(.+?)\s*$", raw)
    if m:
        attack = m.group(1).strip()

    sl = safety_token.lower()
    if "unsafe" in sl:
        return {
            "status": "HARMFUL",
            "safety_label": "Unsafe",
            "category": category,
            "attack_overlay": attack,
        }
    if "controversial" in sl:
        return {
            "status": "HARMLESS",
            "safety_label": "Controversial",
            "category": category,
            "attack_overlay": attack,
        }
    if "safe" in sl:
        return {
            "status": "HARMLESS",
            "safety_label": "Safe",
            "category": category,
            "attack_overlay": attack,
        }
    # Fallback: conservative default for ambiguous output
    if re.search(r"(?i)\b(jailbreak|injection|harmful|malicious)\b", raw):
        return {
            "status": "HARMFUL",
            "safety_label": "Unsafe",
            "category": category if category != "none" else "jailbreak",
            "attack_overlay": attack,
        }
    return {
        "status": "HARMLESS",
        "safety_label": "Safe",
        "category": category,
        "attack_overlay": attack,
    }


def _build_openai_chat_completion(classify: dict[str, Any], model_name: str) -> dict[str, Any]:
    lines = [
        f"Safety: {classify.get('safety_label', '')}",
        f"Categories: {classify.get('category', '')}",
        f"AttackOverlay: {classify.get('attack_overlay', '')}",
        f"Status: {classify.get('status', '')}",
    ]
    content = "\n".join(lines)
    return {
        "id": f"chatcmpl_{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": 0,
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


@dataclass
class ServerState:
    model: Any
    tokenizer: Any
    device: torch.device
    model_id: str
    max_length: int
    max_new_tokens: int
    system_prompt: str | None


def classify_query(state: ServerState, user_text: str, *, role: str | None = None) -> dict[str, Any]:
    conditioned = _apply_classify_role_to_user_text(user_text, role)
    messages: list[dict[str, str]] = []
    if state.system_prompt:
        messages.append({"role": "system", "content": state.system_prompt})
    messages.append({"role": "user", "content": conditioned})

    tok = state.tokenizer
    try:
        prompt = tok.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    except Exception as exc:
        raise RuntimeError(
            "apply_chat_template failed; check chat_template.jinja loaded correctly or upgrade transformers."
        ) from exc

    inputs = tok(prompt, return_tensors="pt", truncation=True, max_length=state.max_length)
    inputs = {k: v.to(state.device) for k, v in inputs.items()}

    pad_id = tok.pad_token_id
    if pad_id is None:
        pad_id = tok.eos_token_id

    with torch.inference_mode():
        out = state.model.generate(
            **inputs,
            max_new_tokens=state.max_new_tokens,
            do_sample=False,
            pad_token_id=pad_id,
            eos_token_id=tok.eos_token_id,
        )
    in_len = inputs["input_ids"].shape[1]
    gen_ids = out[0, in_len:]
    decoded = tok.decode(gen_ids, skip_special_tokens=True)
    return _parse_guard_lines(decoded)


class OpenAICompatServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class, state: ServerState):
        super().__init__(server_address, handler_class)
        self.state = state


class OpenAICompatHandler(BaseHTTPRequestHandler):
    server_version = "HaloGuard/2.0"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            st: ServerState = self.server.state
            self._send_json(
                200,
                {
                    "status": "ok",
                    "model_type": "qwen3_5_guard",
                    "model_name": st.model_id,
                    "structured_output": ["Safety", "Category", "AttackOverlay"],
                    "device": str(st.device),
                },
            )
            return
        self._send_json(404, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:
        if self.path not in ("/v1/chat/completions", "/v1/classify"):
            self._send_json(404, {"error": {"message": "Not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_048_576:
                self._send_json(413, {"error": {"message": "Request body too large"}})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"error": {"message": f"Invalid JSON: {exc}"}})
            return

        st: ServerState = self.server.state
        user_message = _extract_user_message(payload)
        if not user_message:
            self._send_json(400, {"error": {"message": "No user message found in request"}})
            return

        classify_role = _normalize_classify_role(payload) if self.path == "/v1/classify" else None

        log.info(
            "POST %s role=%s (query_chars=%d) — running guard inference…",
            self.path,
            classify_role or "(none)",
            len(user_message),
        )
        result = classify_query(st, user_message, role=classify_role)
        log.info(
            "POST %s -> status=%s safety_label=%s category=%s",
            self.path,
            result.get("status"),
            result.get("safety_label"),
            result.get("category"),
        )
        if self.path == "/v1/classify":
            self._send_json(200, result)
            return

        model_name = str(payload.get("model") or st.model_id)
        self._send_json(200, _build_openai_chat_completion(result, model_name))

    def log_message(self, _format: str, *_args: Any) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve astroware/Halo0.8B-guard-v1 (or compatible Qwen3.5 guard).")
    parser.add_argument(
        "--model-path",
        default=DEFAULT_MODEL_ID,
        help="HF model id or local directory (default: %(default)s)",
    )
    parser.add_argument("--model-revision", default=None, help="Optional HF revision / branch / tag")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8000, help="Bind port")
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, or mps")
    parser.add_argument("--dtype", default="auto", help="auto, float16, bfloat16, float32")
    parser.add_argument("--max-length", type=int, default=2048, help="Prompt max tokens (truncation)")
    parser.add_argument("--max-new-tokens", type=int, default=128, help="Max tokens to generate")
    parser.add_argument("--system-prompt", default=None, help="Optional system message for chat template")
    parser.add_argument(
        "--local-files-only",
        action="store_true",
        help="HF Hub: use only local cache (no download)",
    )
    parser.add_argument(
        "--no-trust-remote-code",
        action="store_true",
        help="Disable trust_remote_code on from_pretrained (default: enabled for Qwen3.x)",
    )
    args = parser.parse_args()

    device = _resolve_torch_device(args.device)
    torch_dtype = _resolve_torch_dtype(args.dtype, device)

    model_id = args.model_path
    trust_remote_code = not args.no_trust_remote_code

    # transformers >=5.0 renamed torch_dtype → dtype; use whichever the installed version accepts.
    import inspect as _inspect
    _model_sig = _inspect.signature(AutoModelForCausalLM.from_pretrained)
    _dtype_key = "dtype" if "dtype" in _model_sig.parameters else "torch_dtype"

    model_kw: dict[str, Any] = {
        _dtype_key: torch_dtype,
        "local_files_only": args.local_files_only,
        "trust_remote_code": trust_remote_code,
    }
    if args.model_revision:
        model_kw["revision"] = args.model_revision

    log.info("device=%s  dtype=%s  trust_remote_code=%s", device, torch_dtype, trust_remote_code)

    # -- tokenizer --
    t0 = time.monotonic()
    log.info("=== PHASE 1/4: tokenizer (Hub small files) — %s ===", model_id)
    tokenizer = _load_tokenizer(
        model_id,
        revision=args.model_revision,
        local_files_only=args.local_files_only,
        trust_remote_code=trust_remote_code,
    )
    log.info("=== PHASE 1 done: tokenizer ready (%.1fs) ===", time.monotonic() - t0)

    # -- model --
    t0 = time.monotonic()
    log.info(
        "=== PHASE 2/4: model weights — download if missing, then mmap/read (~1–2GB first run) ==="
    )
    log.info(
        "If nothing new appears for a while, the process is usually still streaming model.safetensors or reading from disk — not stuck."
    )
    _hb_stop = threading.Event()
    _heartbeat_until_event("Phase 2: model weights (download/load)", _hb_stop, interval_sec=30.0)
    try:
        model = AutoModelForCausalLM.from_pretrained(model_id, **model_kw)
    finally:
        _hb_stop.set()
    log.info("=== PHASE 2 done: weights in memory (%.1fs) ===", time.monotonic() - t0)

    t0 = time.monotonic()
    log.info("=== PHASE 3/4: move weights to %s ===", device)
    model.to(device)
    model.eval()
    log.info("=== PHASE 3 done: model on %s (%.1fs) ===", device, time.monotonic() - t0)

    state = ServerState(
        model=model,
        tokenizer=tokenizer,
        device=device,
        model_id=model_id,
        max_length=args.max_length,
        max_new_tokens=args.max_new_tokens,
        system_prompt=args.system_prompt,
    )

    log.info("=== PHASE 4/4: bind HTTP server ===")
    server = OpenAICompatServer((args.host, args.port), OpenAICompatHandler, state)
    log.info("=== READY: Serving on http://%s:%d (GET /health should work now) ===", args.host, args.port)
    log.info("  POST /v1/classify          - Halo JSON")
    log.info("  POST /v1/chat/completions  - OpenAI-style envelope")
    log.info("  GET  /health               - Health check")
    server.serve_forever()


if __name__ == "__main__":
    main()
