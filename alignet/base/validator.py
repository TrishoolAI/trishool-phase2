# The MIT License (MIT)
# Copyright © 2023 Yuma Rao
# TODO(developer): Set your name
# Copyright © 2023 <your name>

# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the “Software”), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
# and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.

# THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
# THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

import os
import copy
import numpy as np
import asyncio
import argparse
import threading
import bittensor as bt
import time
from typing import List, Union
from traceback import print_exception

from alignet.base.neuron import BaseNeuron
from alignet.base.utils.weight_utils import scores_to_weights_dict
from alignet.utils.config import add_validator_args
from alignet.utils.logging import get_logger
from alignet.utils.telegram import send_error_safe

logger = get_logger()


class BaseValidatorNeuron(BaseNeuron):
    """
    Base class for Bittensor validators (v11). Chain client + weight setting only;
    axon/dendrite networking is removed — miner traffic uses platform HTTP.
    """

    neuron_type: str = "ValidatorNeuron"

    @classmethod
    def add_args(cls, parser: argparse.ArgumentParser):
        super().add_args(parser)
        add_validator_args(cls, parser)

    def __init__(self, config=None):
        super().__init__(config=config)

        self.hotkeys = list(self.metagraph.hotkeys)

        logger.info("Building validation weights.")
        self.scores = np.zeros(len(self.metagraph), dtype=np.float32)

        self.sync()

        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            try:
                self.loop = asyncio.get_event_loop()
            except RuntimeError:
                self.loop = None

        self.should_exit: bool = False
        self.is_running: bool = False
        self.thread: Union[threading.Thread, None] = None
        self.lock = asyncio.Lock()

    async def concurrent_forward(self):
        coroutines = [
            self.forward()
            for _ in range(self.config.neuron.num_concurrent_forwards)
        ]
        await asyncio.gather(*coroutines)

    def run(self):
        """
        Initiates and manages the main validator loop on the Bittensor network.
        """
        self.sync()

        logger.info(f"Validator starting at block: {self.block}")
        hotkey = (
            self.wallet.hotkey.ss58_address
            if hasattr(self, "wallet") and self.wallet
            else ""
        )

        try:
            if self.loop is None:
                self.loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self.loop)

            while True:
                try:
                    logger.info(f"step({self.step}) block({self.block})")

                    self.loop.run_until_complete(self.concurrent_forward())

                    if self.should_exit:
                        break

                    self.sync()

                    self.step += 1

                except Exception as err:
                    error_msg = f"Error during validation: {str(err)}"
                    logger.error(error_msg)
                    send_error_safe(
                        error_message=error_msg,
                        hotkey=hotkey,
                        context="BaseValidator.run",
                        additional_info=f"Step: {self.step}, Block: {self.block}",
                    )
                    time.sleep(5)

        except KeyboardInterrupt:
            logger.warning("Validator killed by keyboard interrupt.")
            exit()

        except Exception as err:
            error_msg = f"Error during validation: {str(err)}"
            logger.error(error_msg)
            logger.debug(
                str(print_exception(type(err), err, err.__traceback__))
            )
            hotkey = (
                self.wallet.hotkey.ss58_address
                if hasattr(self, "wallet") and self.wallet
                else ""
            )
            send_error_safe(
                error_message=error_msg,
                hotkey=hotkey,
                context="BaseValidator.run",
                additional_info="Fatal error in validator run loop",
            )

    def run_in_background_thread(self):
        if not self.is_running:
            try:
                asyncio.get_running_loop()
                logger.debug(
                    "Event loop is running, skipping background thread (async mode detected)."
                )
                return
            except RuntimeError:
                pass

            logger.info("Starting validator in background thread.")
            self.should_exit = False
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()
            self.is_running = True
            logger.info("Started")

    def stop_run_thread(self):
        if self.is_running:
            logger.info("Stopping validator in background thread.")
            self.should_exit = True
            self.thread.join(5)
            self.is_running = False
            logger.info("Stopped")

    def __enter__(self):
        print("Entering validator context")
        self.run_in_background_thread()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self.is_running:
            logger.debug("Stopping validator in background thread.")
            self.should_exit = True
            self.thread.join(5)
            self.is_running = False
            logger.debug("Stopped")

    def set_weights(self):
        """
        Sets validator weights on chain via bt.SetWeights (v11 intent).
        """
        if np.isnan(self.scores).any():
            logger.warning(
                "Scores contain NaN values. This may be due to a lack of responses "
                "from miners, or a bug in your reward functions."
            )

        weights = scores_to_weights_dict(self.scores)
        if not weights:
            logger.warning("No non-zero scores to set as weights; skipping set_weights")
            return

        logger.info(f"Setting weights for {len(weights)} uids: {weights}")

        result = self.subtensor.execute(
            bt.SetWeights(
                netuid=self.config.netuid,
                weights=weights,
                version_key=self.spec_version,
            ),
            self.wallet,
            wait_for_inclusion=True,
            wait_for_finalization=True,
        )
        if result.success:
            logger.info("set_weights on chain successfully!")
        else:
            err = result.error
            code = getattr(err, "code", None)
            msg = getattr(err, "message", None) or str(err)
            remediation = getattr(err, "remediation", None)
            if "too soon" not in str(msg).lower() and "rate" not in str(msg).lower():
                logger.error(
                    f"set_weights failed: code={code} message={msg} remediation={remediation}"
                )
            else:
                logger.warning(f"set_weights rate-limited: {msg}")

    def resync_metagraph(self):
        """Refetch metagraph and update hotkeys / score vector sizing."""
        logger.info("run resync_metagraph")

        previous_hotkeys = list(self.hotkeys)
        previous_axons = [
            n.axon for n in self.metagraph.neurons
        ] if self.metagraph is not None else []

        mg = self.subtensor.subnets.metagraph(self.config.netuid)
        if mg is None:
            logger.error(
                f"Failed to refetch metagraph for netuid {self.config.netuid}"
            )
            return
        self.metagraph = mg

        new_axons = [n.axon for n in self.metagraph.neurons]
        if previous_axons == new_axons and previous_hotkeys == list(self.metagraph.hotkeys):
            return

        logger.info(
            "Metagraph updated, re-syncing hotkeys and moving averages"
        )
        for uid, hotkey in enumerate(previous_hotkeys):
            if uid < len(self.metagraph.hotkeys) and hotkey != self.metagraph.hotkeys[uid]:
                if uid < len(self.scores):
                    self.scores[uid] = 0

        n = len(self.metagraph)
        if len(self.scores) != n:
            new_scores = np.zeros(n, dtype=np.float32)
            min_len = min(len(self.scores), n)
            new_scores[:min_len] = self.scores[:min_len]
            self.scores = new_scores

        self.hotkeys = list(self.metagraph.hotkeys)

    def update_scores(self, rewards: np.ndarray, uids: List[int]):
        """Performs exponential moving average on the scores based on rewards."""

        if np.isnan(rewards).any():
            logger.warning(f"NaN values detected in rewards: {rewards}")
            rewards = np.nan_to_num(rewards, nan=0)

        rewards = np.asarray(rewards)

        if isinstance(uids, np.ndarray):
            uids_array = uids.copy()
        else:
            uids_array = np.array(uids)

        if rewards.size == 0 or uids_array.size == 0:
            logger.info(f"rewards: {rewards}, uids_array: {uids_array}")
            logger.warning(
                "Either rewards or uids_array is empty. No updates will be performed."
            )
            return

        if rewards.size != uids_array.size:
            raise ValueError(
                f"Shape mismatch: rewards array of shape {rewards.shape} "
                f"cannot be broadcast to uids array of shape {uids_array.shape}"
            )

        scattered_rewards: np.ndarray = np.zeros_like(self.scores)
        scattered_rewards[uids_array] = rewards
        logger.debug(f"Scattered rewards: {rewards}")

        alpha: float = self.config.neuron.moving_average_alpha
        self.scores: np.ndarray = (
            alpha * scattered_rewards + (1 - alpha) * self.scores
        )
        logger.debug(f"Updated moving avg scores: {self.scores}")

    def save_state(self):
        """Saves the state of the validator to a file."""
        logger.info("Saving validator state.")

        np.savez(
            self.config.neuron.full_path + "/state.npz",
            step=self.step,
            scores=self.scores,
            hotkeys=self.hotkeys,
        )

    def load_state(self):
        """Loads the state of the validator from a file."""
        logger.info("Loading validator state.")

        state_path = self.config.neuron.full_path + "/state.npz"
        if not os.path.exists(state_path):
            logger.info("No state file found, skipping load_state")
            return

        state = np.load(state_path)
        self.step = state["step"]
        self.scores = state["scores"]
        self.hotkeys = state["hotkeys"]
