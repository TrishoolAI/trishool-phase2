# The MIT License (MIT)
# Copyright © 2023 Yuma Rao

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

import copy
import bittensor as bt
from bittensor.wallet import Wallet

from abc import ABC, abstractmethod

from alignet.utils.config import check_config, add_args, config, Config
from alignet.utils.misc import ttl_get_block
from alignet import __spec_version__ as spec_version

from alignet.utils.logging import get_logger
from alignet.utils.telegram import send_error_safe

logger = get_logger()


class BaseNeuron(ABC):
    """
    Base class for Bittensor neurons (v11). Creates wallet, Subtensor client, and metagraph,
    and handles network sync / weight-setting cadence.
    """

    neuron_type: str = "BaseNeuron"

    @classmethod
    def check_config(cls, config: Config):
        check_config(cls, config)

    @classmethod
    def add_args(cls, parser):
        add_args(cls, parser)

    @classmethod
    def config(cls) -> Config:
        return config(cls)

    subtensor: bt.Subtensor
    wallet: Wallet
    metagraph: bt.Metagraph
    spec_version: int = spec_version

    @property
    def block(self):
        return ttl_get_block(self)

    def __init__(self, config=None):
        base_config = copy.deepcopy(config or BaseNeuron.config())
        self.config = self.config()
        self.config.merge(base_config)
        self.check_config(self.config)

        self.device = self.config.neuron.device

        self.wallet = Wallet(
            name=self.config.wallet.name,
            hotkey=self.config.wallet.hotkey,
            path=self.config.wallet.path,
        )
        self.subtensor = bt.Subtensor(self.config.network)
        self.metagraph = self.subtensor.subnets.metagraph(self.config.netuid)
        if self.metagraph is None:
            raise RuntimeError(
                f"Subnet netuid {self.config.netuid} does not exist on network {self.config.network}"
            )

        logger.info(f"Wallet: {self.wallet}")
        logger.info(f"Subtensor: {self.subtensor}")
        logger.info(f"Metagraph: {self.metagraph}")

        self.check_registered()

        neuron = self.metagraph.by_hotkey(self.wallet.hotkey.ss58_address)
        if neuron is None:
            raise RuntimeError(
                f"Hotkey {self.wallet.hotkey.ss58_address} not found in metagraph"
            )
        self.uid = neuron.uid
        logger.info(
            f"Running neuron on subnet: {self.config.netuid} with uid {self.uid} "
            f"using network: {self.config.network}"
        )
        self.step = 0

    @abstractmethod
    async def forward(self):
        ...

    @abstractmethod
    def run(self):
        ...

    def sync(self):
        """
        Wrapper for synchronizing the state of the network for the given miner or validator.
        """
        logger.info("Syncing network")
        try:
            self.check_registered()

            if self.should_sync_metagraph():
                self.resync_metagraph()

            if self.should_set_weights():
                self.set_weights()

            self.save_state()
        except Exception as e:
            error_msg = f"Error syncing network: {str(e)}"
            logger.error(error_msg)
            hotkey = (
                self.wallet.hotkey.ss58_address
                if hasattr(self, "wallet") and self.wallet
                else ""
            )
            send_error_safe(
                error_message=error_msg,
                hotkey=hotkey,
                context="BaseNeuron.sync",
            )

    def check_registered(self):
        hotkey = (
            self.wallet.hotkey.ss58_address
            if hasattr(self, "wallet") and self.wallet
            else ""
        )
        uid = self.subtensor.neurons.uid(
            hotkey_ss58=self.wallet.hotkey.ss58_address,
            netuid=self.config.netuid,
        )
        if uid is None:
            error_msg = (
                f"Wallet: {self.wallet} is not registered on netuid {self.config.netuid}."
                f" Please register the hotkey using `btcli tx burned-register` before trying again"
            )
            logger.error(error_msg)
            send_error_safe(
                error_message=error_msg,
                hotkey=hotkey,
                context="BaseNeuron.check_registered",
                additional_info=f"NetUID: {self.config.netuid}",
            )
            exit()

    def _blocks_since_last_update(self) -> int:
        """Blocks since this uid last set/committed weights (v11 metagraph field)."""
        try:
            neuron = self.metagraph.neuron(self.uid)
            return max(0, self.block - int(neuron.last_update))
        except Exception:
            blocks = self.subtensor.epochs.blocks_since_last_update(
                netuid=self.config.netuid, uid=self.uid
            )
            return int(blocks) if blocks is not None else 0

    def should_sync_metagraph(self):
        """
        Check if enough epoch blocks have elapsed since the last checkpoint to sync.
        """
        return self._blocks_since_last_update() > self.config.neuron.epoch_length

    def should_set_weights(self) -> bool:
        if self.step == 0:
            return False

        if self.config.neuron.disable_set_weights:
            return False

        return (
            self._blocks_since_last_update() > self.config.neuron.epoch_length
            and self.neuron_type != "MinerNeuron"
        )

    def save_state(self):
        logger.info(
            "save_state() not implemented for this neuron. You can implement this function to save model checkpoints or other useful data."
        )

    def load_state(self):
        logger.info(
            "load_state() not implemented for this neuron. You can implement this function to load model checkpoints or other useful data."
        )
