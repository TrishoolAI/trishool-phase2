from datetime import datetime, timezone
import time
from typing import Any
import argparse

import bittensor as bt
import typer
from rich.console import Console

console = Console(log_time_format="[%Y-%m-%d %H:%M:%S]")
CHALLENGE_PREFIX = "pair-auth"
CHALLENGE_TTL_SECONDS = 120


########################################################################################################################
# SIGNATURE GENERATION
########################################################################################################################


def get_wallet(name: str, hotkey: str) -> bt.wallet:
    if bt is None:  # pragma: no cover
        raise RuntimeError("bittensor is not installed")
    return bt.wallet(name=name, hotkey=hotkey)


def load_wallet(wallet_name: str, wallet_hotkey: str) -> bt.wallet:
    try:
        wallet = get_wallet(wallet_name, wallet_hotkey)
    except bt.KeyFileError as exc:
        console.log(
            "[bold red]Missing hotkey files[/] "
            f"for wallet '{wallet_name}/{wallet_hotkey}'. Import or create the wallet before retrying."
        )
        raise typer.Exit(code=1) from exc
    except Exception as exc:  # pragma: no cover - defensive
        console.log(f"[bold red]Failed to load wallet[/]: {exc}")
        raise typer.Exit(code=1) from exc

    return wallet


def build_pair_auth_payload(
    *,
    network: str,
    netuid: int,
    wallet_name: str,
    wallet_hotkey: str,
    ttl: int = CHALLENGE_TTL_SECONDS,
) -> dict[str, Any]:
    wallet = load_wallet(wallet_name, wallet_hotkey)

    timestamp = int(time.time())
    message = (
        f"{CHALLENGE_PREFIX}|network:{network}|netuid:{netuid}|"
        f"hotkey:{wallet.hotkey.ss58_address}|ts:{timestamp}"
    )
    message_bytes = message.encode("utf-8")
    signature_bytes = wallet.hotkey.sign(message_bytes)

    verifier_keypair = bt.Keypair(ss58_address=wallet.hotkey.ss58_address)
    if not verifier_keypair.verify(message_bytes, signature_bytes):
        console.log("[bold red]Unable to verify the ownership signature locally.[/]")
        raise typer.Exit(code=1)

    expires_at = timestamp + CHALLENGE_TTL_SECONDS
    expiry_time = datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat()
    # console.log(
    #     "[bold green]Ownership challenge signed[/] "
    #     f"(expires in {CHALLENGE_TTL_SECONDS}s at {expiry_time})."
    # )

    return {
        "message": message,
        "signature": "0x" + signature_bytes.hex(),
        "expires_at": expires_at,
    }


if __name__ == "__main__":
    from pprint import pprint
    parser = argparse.ArgumentParser()
    parser.add_argument("--network", type=str, default="finney")
    parser.add_argument("--netuid", type=int, default=23)
    parser.add_argument("--wallet_name", type=str, default="my_wallet")
    parser.add_argument("--wallet_hotkey", type=str, default="my_hotkey")
    parser.add_argument("--ttl", type=int, default=CHALLENGE_TTL_SECONDS)
    args = parser.parse_args()
    network = args.network
    netuid = args.netuid
    wallet_name = args.wallet_name
    wallet_hotkey = args.wallet_hotkey
    ttl = args.ttl

    payload = build_pair_auth_payload(
        network=network,
        netuid=netuid,
        wallet_name=wallet_name,
        wallet_hotkey=wallet_hotkey,
        ttl=ttl,
    )

    pprint(payload)