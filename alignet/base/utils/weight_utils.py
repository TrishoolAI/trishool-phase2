"""Weight helpers for v11 validators.

``bt.SetWeights`` performs clipping, normalization, and u16 quantization
internally — callers only need non-negative relative floats keyed by uid.
"""

from __future__ import annotations

from typing import Dict

import numpy as np

from alignet.utils.logging import get_logger

logger = get_logger()


def scores_to_weights_dict(scores: np.ndarray) -> Dict[int, float]:
    """L1-normalize scores and return ``{uid: weight}`` for non-zero entries.

    Returns an empty dict when there is nothing to emit (all zeros / NaN).
    """
    scores = np.asarray(scores, dtype=np.float64)
    if scores.size == 0:
        return {}

    scores = np.nan_to_num(scores, nan=0.0)
    if np.any(scores < 0):
        logger.warning("Negative scores found; clamping to zero before set_weights")
        scores = np.maximum(scores, 0.0)

    total = float(np.sum(scores))
    if total <= 0:
        return {}

    normalized = scores / total
    return {
        int(uid): float(weight)
        for uid, weight in enumerate(normalized)
        if weight > 0
    }
