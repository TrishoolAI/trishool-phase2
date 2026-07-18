# The MIT License (MIT)
# Copyright © 2023 Yuma Rao
# Copyright © 2023 Opentensor Foundation

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
import subprocess
import argparse
from types import SimpleNamespace
from alignet.utils.logging import get_logger

logger = get_logger()

DEFAULT_WALLET_PATH = os.path.expanduser("~/.bittensor/wallets")
DEFAULT_LOGGING_DIR = os.path.expanduser("~/.bittensor/neurons")


def is_cuda_available():
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "-L"], stderr=subprocess.STDOUT
        )
        if "NVIDIA" in output.decode("utf-8"):
            return "cuda"
    except Exception:
        pass
    try:
        output = subprocess.check_output(["nvcc", "--version"]).decode("utf-8")
        if "release" in output:
            return "cuda"
    except Exception:
        pass
    return "cpu"


class Config(SimpleNamespace):
    """Nested config object with merge support (replaces bt.Config)."""

    def merge(self, other: "Config | None") -> "Config":
        if other is None:
            return self
        for key, value in vars(other).items():
            if key.startswith("_"):
                continue
            existing = getattr(self, key, None)
            if isinstance(existing, SimpleNamespace) and isinstance(
                value, SimpleNamespace
            ):
                existing.merge(value) if hasattr(existing, "merge") else _merge_ns(
                    existing, value
                )
            else:
                setattr(self, key, value)
        return self


def _merge_ns(dst: SimpleNamespace, src: SimpleNamespace) -> None:
    for key, value in vars(src).items():
        if key.startswith("_"):
            continue
        existing = getattr(dst, key, None)
        if isinstance(existing, SimpleNamespace) and isinstance(value, SimpleNamespace):
            _merge_ns(existing, value)
        else:
            setattr(dst, key, value)


def _ns(**kwargs) -> Config:
    return Config(**kwargs)


def check_config(cls, config: Config):
    """Checks/validates the config namespace object and creates neuron paths."""
    full_path = os.path.expanduser(
        "{}/{}/{}/netuid{}/{}".format(
            config.logging.logging_dir,
            config.wallet.name,
            config.wallet.hotkey,
            config.netuid,
            config.neuron.name,
        )
    )
    config.neuron.full_path = os.path.expanduser(full_path)
    if not os.path.exists(config.neuron.full_path):
        os.makedirs(config.neuron.full_path, exist_ok=True)


def add_args(cls, parser):
    """Adds relevant arguments to the parser for operation."""

    parser.add_argument("--netuid", type=int, help="Subnet netuid", default=1)

    parser.add_argument(
        "--network",
        "-n",
        type=str,
        help="Network name (finney/test/local) or a ws:// endpoint.",
        default=os.environ.get("BT_NETWORK", "finney"),
    )

    parser.add_argument(
        "--wallet",
        "-w",
        dest="wallet_name",
        type=str,
        help="Coldkey wallet name.",
        default=os.environ.get("BT_WALLET", "default"),
    )

    parser.add_argument(
        "--wallet-hotkey",
        "-H",
        dest="wallet_hotkey",
        type=str,
        help="Hotkey name within the wallet.",
        default=os.environ.get("BT_WALLET_HOTKEY", "default"),
    )

    parser.add_argument(
        "--wallet-path",
        type=str,
        help="Wallet directory.",
        default=os.environ.get("BT_WALLET_PATH", DEFAULT_WALLET_PATH),
    )

    parser.add_argument(
        "--neuron.device",
        type=str,
        help="Device to run on.",
        default=is_cuda_available(),
    )

    parser.add_argument(
        "--neuron.epoch_length",
        type=int,
        help="The default epoch length (how often we set weights, measured in blocks).",
        default=100,
    )

    parser.add_argument(
        "--neuron.events_retention_size",
        type=str,
        help="Events retention size.",
        default=2 * 1024 * 1024 * 1024,  # 2 GB
    )

    parser.add_argument(
        "--neuron.dont_save_events",
        action="store_true",
        help="If set, we dont save events to a log file.",
        default=False,
    )

    parser.add_argument(
        "--wandb.off",
        action="store_true",
        help="Turn off wandb.",
        default=False,
    )

    parser.add_argument(
        "--wandb.offline",
        action="store_true",
        help="Runs wandb in offline mode.",
        default=False,
    )

    parser.add_argument(
        "--wandb.notes",
        type=str,
        help="Notes to add to the wandb run.",
        default="",
    )


def add_miner_args(cls, parser):
    """Add miner specific arguments to the parser."""

    parser.add_argument(
        "--neuron.name",
        type=str,
        help="Trials for this neuron go in neuron.root / (wallet_cold - wallet_hot) / neuron.name. ",
        default="miner",
    )

    parser.add_argument(
        "--blacklist.force_validator_permit",
        action="store_true",
        help="If set, we will force incoming requests to have a permit.",
        default=False,
    )

    parser.add_argument(
        "--blacklist.allow_non_registered",
        action="store_true",
        help="If set, miners will accept queries from non registered entities. (Dangerous!)",
        default=False,
    )

    parser.add_argument(
        "--wandb.project_name",
        type=str,
        default="template-miners",
        help="Wandb project to log to.",
    )

    parser.add_argument(
        "--wandb.entity",
        type=str,
        default="opentensor-dev",
        help="Wandb entity to log to.",
    )


def add_validator_args(cls, parser):
    """Add validator specific arguments to the parser."""

    parser.add_argument(
        "--neuron.name",
        type=str,
        help="Trials for this neuron go in neuron.root / (wallet_cold - wallet_hot) / neuron.name. ",
        default="validator",
    )

    parser.add_argument(
        "--neuron.timeout",
        type=float,
        help="The timeout for each forward call in seconds.",
        default=10,
    )

    parser.add_argument(
        "--neuron.num_concurrent_forwards",
        type=int,
        help="The number of concurrent forwards running at any time.",
        default=1,
    )

    parser.add_argument(
        "--neuron.sample_size",
        type=int,
        help="The number of miners to query in a single step.",
        default=50,
    )

    parser.add_argument(
        "--neuron.disable_set_weights",
        action="store_true",
        help="Disables setting weights.",
        default=False,
    )

    parser.add_argument(
        "--neuron.moving_average_alpha",
        type=float,
        help="Moving average alpha parameter, how much to add of the new observation.",
        default=0.1,
    )

    parser.add_argument(
        "--neuron.axon_off",
        "--axon_off",
        action="store_true",
        help="Unused in v11 (axon/dendrite removed). Kept for CLI compatibility.",
        default=True,
    )

    parser.add_argument(
        "--neuron.vpermit_tao_limit",
        type=int,
        help="The maximum number of TAO allowed to query a validator with a vpermit.",
        default=4096,
    )

    parser.add_argument(
        "--wandb.project_name",
        type=str,
        help="The name of the project where you are sending the new run.",
        default="template-validators",
    )

    parser.add_argument(
        "--wandb.entity",
        type=str,
        help="The name of the project where you are sending the new run.",
        default="opentensor-dev",
    )


def _getattr_dotted(ns: argparse.Namespace, key: str, default=None):
    """Read argparse values that used dotted option names (dest keeps the dots)."""
    return getattr(ns, key, default)


def namespace_to_config(args: argparse.Namespace) -> Config:
    """Convert flat argparse Namespace into nested Config used by neurons."""
    return _ns(
        netuid=args.netuid,
        network=args.network,
        wallet=_ns(
            name=args.wallet_name,
            hotkey=args.wallet_hotkey,
            path=os.path.expanduser(args.wallet_path),
        ),
        logging=_ns(
            logging_dir=DEFAULT_LOGGING_DIR,
        ),
        neuron=_ns(
            device=_getattr_dotted(args, "neuron.device", is_cuda_available()),
            epoch_length=_getattr_dotted(args, "neuron.epoch_length", 100),
            events_retention_size=_getattr_dotted(
                args, "neuron.events_retention_size", 2 * 1024 * 1024 * 1024
            ),
            dont_save_events=_getattr_dotted(args, "neuron.dont_save_events", False),
            name=_getattr_dotted(args, "neuron.name", "validator"),
            timeout=_getattr_dotted(args, "neuron.timeout", 10),
            num_concurrent_forwards=_getattr_dotted(
                args, "neuron.num_concurrent_forwards", 1
            ),
            sample_size=_getattr_dotted(args, "neuron.sample_size", 50),
            disable_set_weights=_getattr_dotted(
                args, "neuron.disable_set_weights", False
            ),
            moving_average_alpha=_getattr_dotted(
                args, "neuron.moving_average_alpha", 0.1
            ),
            axon_off=_getattr_dotted(args, "neuron.axon_off", True),
            vpermit_tao_limit=_getattr_dotted(args, "neuron.vpermit_tao_limit", 4096),
            full_path=None,
        ),
        wandb=_ns(
            off=_getattr_dotted(args, "wandb.off", False),
            offline=_getattr_dotted(args, "wandb.offline", False),
            notes=_getattr_dotted(args, "wandb.notes", ""),
            project_name=_getattr_dotted(args, "wandb.project_name", "template-validators"),
            entity=_getattr_dotted(args, "wandb.entity", "opentensor-dev"),
        ),
        # Compatibility alias used by older call sites
        subtensor=_ns(network=args.network),
    )


def config(cls) -> Config:
    """
    Returns the configuration object specific to this miner or validator after adding relevant arguments.
    """
    parser = argparse.ArgumentParser()
    cls.add_args(parser)
    args = parser.parse_args()
    return namespace_to_config(args)
