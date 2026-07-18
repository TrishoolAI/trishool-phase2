"""UID sampling helpers for v11 metagraph (optional / unused by current validator)."""

from __future__ import annotations

import random
from typing import List, Optional

import bittensor as bt
import numpy as np


def check_uid_availability(
    metagraph: bt.Metagraph, uid: int, vpermit_tao_limit: float
) -> bool:
    """True if uid has a served axon and (if vpermit) stake below the limit."""
    try:
        neuron = metagraph.neuron(uid)
    except KeyError:
        return False

    if not neuron.axon:
        return False

    if neuron.validator_permit:
        stake = float(neuron.total_stake.amount)
        if stake > vpermit_tao_limit:
            return False
    return True


def get_random_uids(self, k: int, exclude: Optional[List[int]] = None) -> np.ndarray:
    """Returns k available random uids from the metagraph."""
    candidate_uids = []
    avail_uids = []

    for uid in range(len(self.metagraph)):
        uid_is_available = check_uid_availability(
            self.metagraph, uid, self.config.neuron.vpermit_tao_limit
        )
        uid_is_not_excluded = exclude is None or uid not in exclude

        if uid_is_available:
            avail_uids.append(uid)
            if uid_is_not_excluded:
                candidate_uids.append(uid)

    k = min(k, len(avail_uids))
    available_uids = list(candidate_uids)
    if len(candidate_uids) < k:
        available_uids += random.sample(
            [uid for uid in avail_uids if uid not in candidate_uids],
            k - len(candidate_uids),
        )
    uids = np.array(random.sample(available_uids, k)) if k > 0 else np.array([])
    return uids
