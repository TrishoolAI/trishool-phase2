#!/usr/bin/env python3
"""
Miner CLI tool for uploading submissions to the Platform API

This CLI tool allows miners to easily upload their submission items as JSON file (.json)
to the platform with proper authentication and signature verification.

Usage:
    python -m miner upload \
        --submission-file submission.json \
        --surface-area 1 \
        --coldkey ckorintest1 \
        --hotkey hk1 \
        --network finney \
        --netuid 23 \
        --api-url http://localhost:8000

"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
import typer
from requests.exceptions import RequestException


class MinerCLI:
    """CLI interface for miner operations"""

    def __init__(self, api_url: str):
        """
        Initialize the Miner CLI

        Args:
            api_url: Base URL of the Platform API
        """
        self.api_url = api_url.rstrip("/")
        self.upload_endpoint = f"{self.api_url}/api/v1/miner/upload"

    def validate_submission_file(self, file_path: Path) -> Dict[str, Any]:
        """
        Validate the submission JSON file and return submission items dict

        Args:
            file_path: Path to the submission JSON file
            surface_area: Surface area version (1-5) to validate format

        Returns:
            Dict[str, Any]: Submission items dictionary with Q1-Qn keys

        Raises:
            ValueError: If validation fails
        """
        if not file_path.exists():
            raise ValueError(f"Submission file not found: {file_path}")

        if not file_path.is_file():
            raise ValueError(f"Path is not a file: {file_path}")

        if file_path.stat().st_size == 0:
            raise ValueError("Submission file is empty")

        # Check if file is .json file
        if file_path.suffix != ".json":
            raise ValueError(f"Submission file must be a .json file, got: {file_path.suffix}")

        # Read and parse JSON
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                submission_items = json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON format: {e}")
        except Exception as e:
            raise ValueError(f"Error reading submission file: {e}")

        if len(submission_items.keys()) == 0:
            raise ValueError("Submission items must have at least 1 key (Q1)")

        return submission_items

    def upload_submission(
        self,
        submission_file: Path,
        surface_area: int,
        hotkey: str,
        coldkey: str,
        network: str = "finney",
        netuid: int = 23,
    ) -> dict:
        """
        Upload submission JSON file to the platform
        """
        from bts_signature import build_pair_auth_payload

        # Validate submission file and get submission items dict
        submission_items = self.validate_submission_file(submission_file)
        pair_auth = build_pair_auth_payload(
            network=network,
            netuid=netuid,
            wallet_name=coldkey,
            wallet_hotkey=hotkey,
        )
        
        # Prepare JSON payload
        payload = {
            "message": pair_auth["message"],
            "signature": pair_auth["signature"],
            "expires_at": int(pair_auth["expires_at"]),
            "submission_items": submission_items,
            "surface_area": surface_area,
        }

        # Send request with JSON body
        try:
            response = requests.post(
                self.upload_endpoint,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=100,
            )

            # Check response
            response.raise_for_status()

            return response.json()

        except RequestException as e:
            error_msg = f"Upload failed: {e}"
            if hasattr(e, "response") and e.response is not None:
                try:
                    error_detail = e.response.json()
                    error_msg = f"Upload failed: {error_detail.get('detail', str(e))}"
                except:
                    error_msg = f"Upload failed: {e.response.text}"
            raise RequestException(error_msg) from e


def create_parser() -> argparse.ArgumentParser:
    """Create argument parser for the CLI"""
    parser = argparse.ArgumentParser(
        description="Miner CLI tool for uploading prompts to Platform API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Upload submission with default settings (Surface Area 1)
  python -m alignet.cli.miner upload --submission-file ./submission.json --surface-area 1 --hotkey YOUR_HOTKEY --coldkey YOUR_COLDKEY --network finney --netuid 23
  
  # Upload to custom API URL (Surface Area 2)
  python -m alignet.cli.miner upload --submission-file ./submission.json --surface-area 2 --hotkey YOUR_HOTKEY --coldkey YOUR_COLDKEY --network finney --netuid 23 --api-url https://api.example.com

Submission file format depends on Surface Area:
  Surface Area 1: {"Q1": "prompt", "Q2": "prompt", ...}
  Surface Area 2: {"Q1": {"prompt": "...", "url": "..."}, ...}
  Surface Area 3: {"Q1": {"prompt": "...", "endpoint": "..."}, ...}
  Surface Area 4: {"Q1": {"conversation": [...]}, ...}
  Surface Area 5: {"Q1": {"session1": [...], "session2": [...]}, ...}
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # Upload command
    upload_parser = subparsers.add_parser(
        "upload", help="Upload prompts JSON file to the platform"
    )

    upload_parser.add_argument(
        "--submission-file",
        type=str,
        required=True,
        help="Path to the submission JSON file (.json) with Q1-Qn format",
    )

    upload_parser.add_argument(
        "--surface-area",
        type=int,
        required=True,
        choices=[1, 2, 3, 4, 5],
        help="Surface area version (1-5) to determine submission format",
    )

    upload_parser.add_argument(
        "--hotkey", type=str, required=True, help="Miner hotkey (hot wallet address)"
    )

    upload_parser.add_argument(
        "--coldkey", type=str, required=True, help="Miner coldkey (cold wallet address)"
    )

    upload_parser.add_argument(
        "--network", type=str, required=True, help="Network name"
    )

    upload_parser.add_argument("--netuid", type=int, required=True, help="Network UID")

    upload_parser.add_argument(
        "--api-url",
        type=str,
        default="http://localhost:8000",
        help="Platform API base URL (default: http://localhost:8000)",
    )

    return parser


def main():
    """Main CLI entry point"""
    parser = create_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "upload":
        try:
            # Initialize CLI
            cli = MinerCLI(api_url=args.api_url)

            # Convert submission file path to Path object
            submission_file = Path(args.submission_file).resolve()

            # Display upload details and ask for confirmation
            print("\n" + "=" * 60)
            print("Upload Details:")
            print("=" * 60)
            print(f"Submission File: {submission_file}")
            print(f"Surface Area:    {args.surface_area}")
            print(f"Hotkey:          {args.hotkey}")
            print(f"Coldkey:         {args.coldkey}")
            print(f"Network:         {args.network}")
            print(f"NetUID:          {args.netuid}")
            print(f"API URL:         {args.api_url}")
            print("=" * 60)

            # Ask for confirmation
            confirmation = (
                input("\nDo you want to proceed with the upload? (y/n): ")
                .strip()
                .lower()
            )

            if confirmation != "y":
                print("\n✗ Upload cancelled by user.\n")
                sys.exit(0)

            # Upload submission
            result = cli.upload_submission(
                submission_file=submission_file,
                surface_area=args.surface_area,
                hotkey=args.hotkey,
                coldkey=args.coldkey,
                network=args.network,
                netuid=args.netuid,
            )

            # Print success message
            print("\n" + "=" * 60)
            print("✓ Upload Successful!")
            print("=" * 60)
            print(f"Status:  {result.get('status', 'unknown')}")
            print(f"Message: {result.get('message', 'No message')}")
            print("=" * 60 + "\n")

            sys.exit(0)

        except ValueError as e:
            print(f"\n✗ Validation Error: {e}\n", file=sys.stderr)
            sys.exit(1)

        except RequestException as e:
            print(f"\n✗ Upload Error: {e}\n", file=sys.stderr)
            sys.exit(1)

        except Exception as e:
            print(f"\n✗ Unexpected Error: {e}\n", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
