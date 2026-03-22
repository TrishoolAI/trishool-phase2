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
import logging
import numpy as np
import asyncio
import argparse
import threading
import bittensor as bt
import time
from typing import List, Union
from traceback import print_exception

from alignet.base.neuron import BaseNeuron
from alignet.base.utils.weight_utils import (
    process_weights_for_netuid,
    convert_weights_and_uids_for_emit,
)  # TODO: Replace when bittensor switches to numpy
from alignet.utils.config import add_validator_args
from alignet.utils.logging import get_logger
from alignet.utils.telegram import send_error_safe
logger = get_logger()

class BaseValidatorNeuron(BaseNeuron):
    """
    Base class for Bittensor validators. Your validator should inherit from this class.
    """

    neuron_type: str = "ValidatorNeuron"

    @classmethod
    def add_args(cls, parser: argparse.ArgumentParser):
        super().add_args(parser)
        add_validator_args(cls, parser)

    def __init__(self, config=None):
        super().__init__(config=config)

        # Save a copy of the hotkeys to local memory.
        self.hotkeys = copy.deepcopy(self.metagraph.hotkeys)

        # Dendrite lets us send messages to other nodes (axons) in the network.
        self.dendrite = bt.dendrite(wallet=self.wallet)
        logger.info(f"Dendrite: {self.dendrite}")

        # Set up initial scoring weights for validation
        logger.info("Building validation weights.")
        self.scores = np.zeros(self.metagraph.n, dtype=np.float32)

        # Init sync with the network. Updates the metagraph.
        self.sync()

        # Serve axon to enable external connections.
        if not self.config.neuron.axon_off:
            self.serve_axon()
        else:
            logger.warning("axon off, not serving ip to chain.")

        # Create asyncio event loop to manage async tasks.
        # Use get_event_loop() for Python < 3.10, or get_event_loop_policy() for >= 3.10
        # This will get the current loop if one exists, or create a new one if not
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop, try to get or create one
            try:
                self.loop = asyncio.get_event_loop()
            except RuntimeError:
                # No event loop exists, create a new one (will be set by run())
                self.loop = None

        # Instantiate runners
        self.should_exit: bool = False
        self.is_running: bool = False
        self.thread: Union[threading.Thread, None] = None
        self.lock = asyncio.Lock()

    def serve_axon(self):
        """Serve axon to enable external connections."""
        logger.info("serving ip to chain...")
        try:
            self.axon = bt.axon(wallet=self.wallet, config=self.config)
            hotkey = self.wallet.hotkey.ss58_address if hasattr(self, 'wallet') and self.wallet else ""

            try:
                self.subtensor.serve_axon(
                    netuid=self.config.netuid,
                    axon=self.axon,
                )
                logger.info(
                    f"Running validator {self.axon} on network: {self.config.subtensor.chain_endpoint} with netuid: {self.config.netuid}"
                )
            except Exception as e:
                error_msg = f"Failed to serve Axon with exception: {e}"
                logger.error(error_msg)
                send_error_safe(
                    error_message=error_msg,
                    hotkey=hotkey,
                    context="BaseValidator.serve_axon"
                )
                pass

        except Exception as e:
            error_msg = f"Failed to create Axon initialize with exception: {e}"
            logger.error(error_msg)
            hotkey = self.wallet.hotkey.ss58_address if hasattr(self, 'wallet') and self.wallet else ""
            send_error_safe(
                error_message=error_msg,
                hotkey=hotkey,
                context="BaseValidator.serve_axon"
            )
            pass

    async def concurrent_forward(self):
        coroutines = [
            self.forward()
            for _ in range(self.config.neuron.num_concurrent_forwards)
        ]
        await asyncio.gather(*coroutines)

    def run(self):
        """
        Initiates and manages the main loop for the miner on the Bittensor network. The main loop handles graceful shutdown on keyboard interrupts and logs unforeseen errors.

        This function performs the following primary tasks:
        1. Check for registration on the Bittensor network.
        2. Continuously forwards queries to the miners on the network, rewarding their responses and updating the scores accordingly.
        3. Periodically resynchronizes with the chain; updating the metagraph with the latest network state and setting weights.

        The essence of the validator's operations is in the forward function, which is called every step. The forward function is responsible for querying the network and scoring the responses.

        Note:
            - The function leverages the global configurations set during the initialization of the miner.
            - The miner's axon serves as its interface to the Bittensor network, handling incoming and outgoing requests.

        Raises:
            KeyboardInterrupt: If the miner is stopped by a manual interruption.
            Exception: For unforeseen errors during the miner's operation, which are logged for diagnosis.
        """

        # Check that validator is registered on the network.
        self.sync()

        logger.info(f"Validator starting at block: {self.block}")
        hotkey = self.wallet.hotkey.ss58_address if hasattr(self, 'wallet') and self.wallet else ""

        # This loop maintains the validator's operations until intentionally stopped.
        try:
            # Ensure we have an event loop for run_until_complete
            if self.loop is None:
                self.loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self.loop)
            
            while True:
                try:
                    logger.info(f"step({self.step}) block({self.block})")

                    # Run multiple forwards concurrently.
                    self.loop.run_until_complete(self.concurrent_forward())

                    # Check if we should exit.
                    if self.should_exit:
                        break

                    # Sync metagraph and potentially set weights.
                    self.sync()

                    self.step += 1
                
                except Exception as err:
                    error_msg = f"Error during validation: {str(err)}"
                    logger.error(error_msg)
                    send_error_safe(
                        error_message=error_msg,
                        hotkey=hotkey,
                        context="BaseValidator.run",
                        additional_info=f"Step: {self.step}, Block: {self.block}"
                    )
                    ## sleep for 1 second
                    time.sleep(5)

        # If someone intentionally stops the validator, it'll safely terminate operations.
        except KeyboardInterrupt:
            if self.axon:
                self.axon.stop()
            logger.warning("Validator killed by keyboard interrupt.")
            exit()

        # In case of unforeseen errors, the validator will log the error and continue operations.
        except Exception as err:
            error_msg = f"Error during validation: {str(err)}"
            logger.error(error_msg)
            logger.debug(
                str(print_exception(type(err), err, err.__traceback__))
            )
            hotkey = self.wallet.hotkey.ss58_address if hasattr(self, 'wallet') and self.wallet else ""
            send_error_safe(
                error_message=error_msg,
                hotkey=hotkey,
                context="BaseValidator.run",
                additional_info=f"Fatal error in validator run loop"
            )

    def run_in_background_thread(self):
        """
        Starts the validator's operations in a background thread upon entering the context.
        This method facilitates the use of the validator in a 'with' statement.
        
        Note: If an event loop is already running (e.g., in async test mode),
        this will not start the background thread to avoid conflicts.
        """
        if not self.is_running:
            # Check if we're in an async context (event loop already running)
            try:
                loop = asyncio.get_running_loop()
                # Event loop is running, skip starting background thread
                # This happens when using the validator in async mode (e.g., test scripts)
                logger.debug("Event loop is running, skipping background thread (async mode detected).")
                return
            except RuntimeError:
                # No event loop running, safe to start background thread
                pass
            
            logger.info("Starting validator in background thread.")
            self.should_exit = False
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()
            self.is_running = True
            logger.info("Started")

    def stop_run_thread(self):
        """
        Stops the validator's operations that are running in the background thread.
        """
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
        """
        Stops the validator's background operations upon exiting the context.
        This method facilitates the use of the validator in a 'with' statement.

        Args:
            exc_type: The type of the exception that caused the context to be exited.
                      None if the context was exited without an exception.
            exc_value: The instance of the exception that caused the context to be exited.
                       None if the context was exited without an exception.
            traceback: A traceback object encoding the stack trace.
                       None if the context was exited without an exception.
        """
        if self.is_running:
            logger.debug("Stopping validator in background thread.")
            self.should_exit = True
            self.thread.join(5)
            self.is_running = False
            logger.debug("Stopped")

    def set_weights(self):
        """
        Sets the validator weights to the metagraph hotkeys based on the scores it has received from the miners. The weights determine the trust and incentive level the validator assigns to miner nodes on the network.
        """
        # Check if self.scores contains any NaN values and log a warning if it does.
        if np.isnan(self.scores).any():
            logger.warning(
                f"Scores contain NaN values. This may be due to a lack of responses from miners, or a bug in your reward functions."
            )

        # Calculate the average reward for each uid across non-zero values.
        # Replace any NaN values with 0.
        # Compute the norm of the scores
        norm = np.linalg.norm(self.scores, ord=1, axis=0, keepdims=True)

        # Check if the norm is zero or contains NaN values
        if np.any(norm == 0) or np.isnan(norm).any():
            norm = np.ones_like(norm)  # Avoid division by zero or NaN

        # Compute raw_weights safely
        raw_weights = self.scores / norm

        logger.debug("raw_weights", raw_weights)
        logger.debug("raw_weight_uids", str(self.metagraph.uids.tolist()))
        # Process the raw weights to final_weights via subtensor limitations.
        (
            processed_weight_uids,
            processed_weights,
        ) = process_weights_for_netuid(
            uids=self.metagraph.uids,
            weights=raw_weights,
            netuid=self.config.netuid,
            subtensor=self.subtensor,
            metagraph=self.metagraph,
        )
        # logger.debug(f"processed_weights {processed_weights}")
        # logger.debug(f"processed_weight_uids {processed_weight_uids}")

        # Convert to uint16 weights and uids.
        (
            uint_uids,
            uint_weights,
        ) = convert_weights_and_uids_for_emit(
            uids=processed_weight_uids, weights=processed_weights
        )
        logger.info(f"uint_weights: {uint_weights}")
        logger.info(f"uint_uids: {uint_uids}")

        # Set the weights on chain via our subtensor connection.
        result, msg = self.subtensor.set_weights(
            wallet=self.wallet,
            netuid=self.config.netuid,
            uids=uint_uids,
            weights=uint_weights,
            wait_for_finalization=True,
            wait_for_inclusion=True,
            version_key=self.spec_version,
        )
        if result is True:
            logger.info(f"set_weights on chain successfully! {msg}")
        else:
            logger.error(f"set_weights failed: {msg}")

    def resync_metagraph(self):
        """Resyncs the metagraph and updates the hotkeys and moving averages based on the new metagraph."""
        logger.info("run resync_metagraph")

        # Copies state of metagraph before syncing.
        previous_metagraph = copy.deepcopy(self.metagraph)

        # Sync the metagraph.
        self.metagraph.sync(subtensor=self.subtensor)

        # Check if the metagraph axon info has changed.
        if previous_metagraph.axons == self.metagraph.axons:
            return

        logger.info(
            "Metagraph updated, re-syncing hotkeys, dendrite pool and moving averages"
        )
        # Zero out all hotkeys that have been replaced.
        for uid, hotkey in enumerate(self.hotkeys):
            if hotkey != self.metagraph.hotkeys[uid]:
                self.scores[uid] = 0  # hotkey has been replaced

        # Check to see if the metagraph has changed size.
        # If so, we need to add new hotkeys and moving averages.
        if len(self.hotkeys) < len(self.metagraph.hotkeys):
            # Update the size of the moving average scores.
            new_moving_average = np.zeros((self.metagraph.n))
            min_len = min(len(self.hotkeys), len(self.scores))
            new_moving_average[:min_len] = self.scores[:min_len]
            self.scores = new_moving_average

        # Update the hotkeys.
        self.hotkeys = copy.deepcopy(self.metagraph.hotkeys)

    def update_scores(self, rewards: np.ndarray, uids: List[int]):
        """Performs exponential moving average on the scores based on the rewards received from the miners."""

        # Check if rewards contains NaN values.
        if np.isnan(rewards).any():
            logger.warning(f"NaN values detected in rewards: {rewards}")
            # Replace any NaN values in rewards with 0.
            rewards = np.nan_to_num(rewards, nan=0)

        # Ensure rewards is a numpy array.
        rewards = np.asarray(rewards)

        # Check if `uids` is already a numpy array and copy it to avoid the warning.
        if isinstance(uids, np.ndarray):
            uids_array = uids.copy()
        else:
            uids_array = np.array(uids)

        # Handle edge case: If either rewards or uids_array is empty.
        if rewards.size == 0 or uids_array.size == 0:
            logger.info(f"rewards: {rewards}, uids_array: {uids_array}")
            logger.warning(
                "Either rewards or uids_array is empty. No updates will be performed."
            )
            return

        # Check if sizes of rewards and uids_array match.
        if rewards.size != uids_array.size:
            raise ValueError(
                f"Shape mismatch: rewards array of shape {rewards.shape} "
                f"cannot be broadcast to uids array of shape {uids_array.shape}"
            )

        # Compute forward pass rewards, assumes uids are mutually exclusive.
        # shape: [ metagraph.n ]
        scattered_rewards: np.ndarray = np.zeros_like(self.scores)
        scattered_rewards[uids_array] = rewards
        logger.debug(f"Scattered rewards: {rewards}")

        # Update scores with rewards produced by this step.
        # shape: [ metagraph.n ]
        alpha: float = self.config.neuron.moving_average_alpha
        self.scores: np.ndarray = (
            alpha * scattered_rewards + (1 - alpha) * self.scores
        )
        logger.debug(f"Updated moving avg scores: {self.scores}")

    def save_state(self):
        """Saves the state of the validator to a file."""
        logger.info("Saving validator state.")

        # Save the state of the validator to file.
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
        
        # Load the state of the validator from file.
        state = np.load(state_path)
        self.step = state["step"]
        self.scores = state["scores"]
        self.hotkeys = state["hotkeys"]
