"""
REST API Client for Alignet Subnet Validator.

This module provides a REST API client for connecting to the subnet platform
and fetching miner submissions, submitting scores, etc.
"""

import asyncio
import json
import logging
import aiohttp
from typing import Dict, Any, Optional, List, Union
import os
import sys
from datetime import datetime

# Add project root to path for imports
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from alignet.cli.bts_signature import load_wallet, build_pair_auth_payload
from alignet import __spec_version__ as spec_version
from alignet.utils.logging import get_logger
from alignet.utils.telegram import send_error_to_telegram
logger = get_logger()


class PlatformAPIClient:
    """REST API client for connecting to the subnet platform."""
    
    def __init__(
        self,
        platform_api_url: str = "http://localhost:8000",
        coldkey_name: Optional[str] = None,
        hotkey_name: Optional[str] = None,
        hotkey_address: Optional[str] = None,
        network: str = "finney",
        netuid: int = 23,
    ):
        """
        Initialize the REST API client.
        
        Args:
            platform_api_url: Base URL of the platform API
            coldkey_name: Coldkey name for authentication
            hotkey_name: Hotkey name for authentication
            network: Bittensor network (default: finney)
            netuid: Subnet UID (default: 23)
        """
        self.platform_api_url = platform_api_url.rstrip('/')
        self.coldkey_name = coldkey_name
        self.hotkey_name = hotkey_name
        self.hotkey_address = hotkey_address
        self.network = network
        self.netuid = netuid
        self.wallet = None
        
        # Load wallet if credentials provided
        if self.coldkey_name and self.hotkey_name:
            try:
                self.wallet = load_wallet(self.coldkey_name, self.hotkey_name)
                logger.info(f"Loaded wallet: {self.coldkey_name}/{self.hotkey_name}")
            except Exception as e:
                logger.warning(f"Failed to load wallet: {str(e)}")
        
        logger.info(f"PlatformAPIClient initialized with URL: {self.platform_api_url}")
    
    def _build_auth_headers(self) -> Dict[str, str]:
        """
        Build authentication headers with signature.
        
        Returns:
            Dictionary with authentication headers
        """
        if not self.wallet:
            raise ValueError("Wallet not loaded. Cannot build auth headers.")
        
        payload = build_pair_auth_payload(
            network=self.network,
            netuid=self.netuid,
            wallet_name=self.coldkey_name,
            wallet_hotkey=self.hotkey_name,
        )
        
        headers = {
            "X-Sign-Message": payload["message"],
            "X-Signature": payload["signature"],
            "Content-Type": "application/json",
        }
        
        return headers
    
    async def get_evaluation_inputs(self) -> Optional[Dict[str, Any]]:
        """
        Get evaluation input (challenge + submission) for evaluation.
        Calls GET /api/v1/validator/get-evaluation-data.
        
        Returns:
            EvaluationInputResponse dictionary with challenge, submission, and run_id, or None if no submission available
        """
        url = f"{self.platform_api_url}/api/v1/validator/get-evaluation-data"
        error_text = None
        
        # Retry 3 times
        for i in range(3):
            try:
                headers = self._build_auth_headers()
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, headers=headers) as response:
                        if response.status == 200:
                            data = await response.json()
                            if data:
                                return data
                            else:
                                logger.debug("No evaluation submission available")
                                return None
                        elif response.status == 404:
                            # No submission available - not an error, don't retry
                            logger.debug("No evaluation submission available (404)")
                            return None
                        else:
                            error_text = await response.text()
                            logger.warning(f"Failed to get evaluation agents, retrying... ({i+1}/3): {response.status} - {error_text}")
                            # Don't send telegram notification on retry, only after all retries fail
                            await asyncio.sleep(1)
                            
            except Exception as e:
                error_text = str(e)
                logger.warning(f"Error fetching evaluation agents, retrying... ({i+1}/3): {error_text}")
                await asyncio.sleep(1)
        
        # All retries failed, send telegram notification
        error_msg = f"Failed to get evaluation agents after 3 retries: {error_text}"
        logger.error(error_msg)
        # await send_error_to_telegram(
        #     error_message=error_msg,
        #     hotkey=self.hotkey_address,
        #     context="PlatformAPI.get_evaluation_inputs",
        #     additional_info=f"URL: {url}"
        # )
        return None
    
    async def check_scoring(
        self, question_id: str, submission_id: str, challenge_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Check if scoring exists for a question-item pair.
        
        Args:
            question_id: Question ID (e.g., "Q1", "Q2")
            submission_id: Submission ID
            challenge_id: Challenge ID
        Returns:
            Dictionary with exists and evaluation_status, or None if error
        """
        url = f"{self.platform_api_url}/api/v1/validator/check_scoring"
        params = {
            "question_id": question_id,
            "miner_submission_id": submission_id,
            "challenge_id": challenge_id,
        }
        error_text = None
        
        # Retry 3 times
        for i in range(3):
            try:
                headers = self._build_auth_headers()
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, headers=headers, params=params) as response:
                        if response.status == 200:
                            data = await response.json()
                            return data
                        else:
                            error_text = await response.text()
                            logger.warning(f"Failed to check scoring, retrying... ({i+1}/3): {response.status} - {error_text}")
                            await asyncio.sleep(1)
                            
            except Exception as e:
                error_text = str(e)
                logger.warning(f"Error checking scoring, retrying... ({i+1}/3): {error_text}")
                await asyncio.sleep(1)
        
        # All retries failed
        error_msg = f"Failed to check scoring after 3 retries: {error_text}"
        logger.error(error_msg)
        await send_error_to_telegram(
            error_message=error_msg,
            hotkey=self.hotkey_address,
            context="PlatformAPI.check_scoring",
            additional_info=f"Question ID: {question_id}, Submission ID: {submission_id}, Challenge ID: {challenge_id}"
        )
        return None

    async def check_scoring_multi(
        self,
        submission_id: str,
        challenge_id: str,
        question_ids: List[str],
    ) -> Optional[Dict[str, Any]]:
        """
        Batch check which question_ids already have a SUCCESS scoring for this validator.
        One request instead of N requests.

        Returns:
            {"scored_question_ids": [...], "unscored_question_ids": [...]} or None on error
        """
        if not question_ids:
            return {"scored_question_ids": [], "unscored_question_ids": []}
        url = f"{self.platform_api_url}/api/v1/validator/check_scoring_multi_question"
        body = {
            "submission_id": submission_id,
            "challenge_id": challenge_id,
            "question_ids": question_ids,
        }
        error_text = None
        for i in range(3):
            try:
                headers = self._build_auth_headers()
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, headers=headers, json=body) as response:
                        if response.status == 200:
                            return await response.json()
                        error_text = await response.text()
                        logger.warning(
                            f"check_scoring_multi failed, retrying... ({i+1}/3): {response.status} - {error_text}"
                        )
                        await asyncio.sleep(1)
            except Exception as e:
                error_text = str(e)
                logger.warning(f"check_scoring_multi error, retrying... ({i+1}/3): {error_text}")
                await asyncio.sleep(1)
        error_msg = f"check_scoring_multi failed after 3 retries: {error_text}"
        logger.error(error_msg)
        await send_error_to_telegram(
            error_message=error_msg,
            hotkey=self.hotkey_address,
            context="PlatformAPI.check_scoring_multi",
            additional_info=f"Submission ID: {submission_id}, Challenge ID: {challenge_id}",
        )
        return None


    async def submit_judge_output(
        self, 
        submission_id: str, 
        judge_output: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Submit full judge evaluation output to platform.
        
        Args:
            submission_id: Submission ID
            judge_output: Full judge output JSON (containing run_id, timestamp, config, results, summary)
            
        Returns:
            Response dictionary with status, message, and run_id
        """
        url = f"{self.platform_api_url}/api/v1/validator/submit_scores/{submission_id}"
        error_text = None
        
        # Retry 3 times
        for i in range(3):
            try:
                headers = self._build_auth_headers()

                async with aiohttp.ClientSession() as session:
                    async with session.post(url, headers=headers, json=judge_output) as response:
                        if response.status == 200:
                            data = await response.json()
                            logger.info(f"Submitted judge output for submission {submission_id}, run_id: {judge_output.get('run_id', 'unknown')}")
                            return data
                        else:
                            error_text = await response.text()
                            logger.warning(f"Failed to submit judge output, retrying... ({i+1}/3): {response.status} - {error_text}")
                            # Don't send telegram notification on retry, only after all retries fail
                            await asyncio.sleep(1)
                            
            except Exception as e:
                error_text = str(e)
                logger.warning(f"Error submitting judge output, retrying... ({i+1}/3): {error_text}")
                await asyncio.sleep(1)
        
        # All retries failed, send telegram notification
        error_msg = f"Failed to submit judge output after 3 retries: {error_text}"
        logger.error(error_msg)
        await send_error_to_telegram(
            error_message=error_msg,
            hotkey=self.hotkey_address,
            context="PlatformAPI.submit_judge_output",
            additional_info=f"Submission ID: {submission_id}, Run ID: {judge_output.get('run_id', 'unknown')}"
        )
        return {
            "status": "error",
            "message": error_text,
            "run_id": judge_output.get("run_id", "")
        }
    
    async def get_weights(self) -> Optional[Dict[str, float]]:
        """
        Get weights from platform API.
        
        Returns:
            Dictionary mapping miner UID (as string) to weight, or None if failed
        """
        try:
            headers = self._build_auth_headers()
            url = f"{self.platform_api_url}/api/v1/validator/weights"
            
            ## retry 3 times
            error_text = None
            for i in range(3):
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(url, headers=headers) as response:
                            if response.status == 200:
                                data = await response.json()
                                weights = data.get("weights", {})
                                logger.info(f"Fetched weights for {len(weights)} miners from platform")
                                return weights
                            else:
                                error_text = await response.text()
                                logger.error(f"Failed to get weights, retrying... ({i+1}/3)")
                                await asyncio.sleep(5)
                except Exception as e:
                    error_text = str(e)
                    logger.error(f"Error getting weights: {error_text}")
                    await asyncio.sleep(1)

            error_msg = f"Failed to get weights after 3 retries: {error_text}"
            logger.error(error_msg)
            await send_error_to_telegram(
                error_message=error_msg,
                hotkey=self.hotkey_address,
                context="PlatformAPI.get_weights"
            )
            return None
        except Exception as e:
            error_msg = f"Error getting weights: {str(e)}"
            logger.error(error_msg)
            await send_error_to_telegram(
                error_message=error_msg,
                hotkey=self.hotkey_address,
                context="PlatformAPI.get_weights"
            )
            return None
    
    def _compose_healthcheck_spec_version(
        self, subnet_versions: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Single human-readable spec_version string for the platform (no extra JSON keys).
        Alignet code spec plus one encoded int per agent (from GET /version spec_version),
        e.g. "code_version: 2004, tri_claw_version: 2005, tri_judge_version: 2005".
        Semver strings from /version are not included here.
        """
        segments: List[str] = [f"code_version: {spec_version}"]
        if not subnet_versions:
            return ", ".join(segments)
        for label, key in (
            ("tri_claw_version", "tri_claw_spec_version"),
            ("tri_judge_version", "tri_judge_spec_version"),
        ):
            value = subnet_versions.get(key)
            if value is not None and str(value).strip() != "":
                segments.append(f"{label}: {str(value).strip()}")
        return ", ".join(segments)

    async def healthcheck(self, subnet_versions: Optional[Dict[str, Any]] = None) -> bool:
        """
        Send healthcheck to platform.

        Optional subnet_versions: from tri-claw / tri-judge GET /version; encoded spec
        ints only are folded into spec_version (not semver strings).

        Returns:
            True if successful, False otherwise
        """
        url = f"{self.platform_api_url}/api/v1/validator/healthcheck"
        body: Dict[str, Any] = {
            "hotkey": self.wallet.hotkey.ss58_address if self.wallet else "",
            "spec_version": self._compose_healthcheck_spec_version(subnet_versions),
        }
        error_text = None
        
        # Retry 3 times
        for i in range(3):
            try:
                headers = self._build_auth_headers()
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, headers=headers, json=body) as response:
                        if response.status == 200:
                            logger.debug("Healthcheck successful")
                            return True
                        else:
                            error_text = await response.text()
                            logger.warning(f"Healthcheck failed, retrying... ({i+1}/3): {response.status} - {error_text}")
                            # Don't send telegram notification on retry, only after all retries fail
                            await asyncio.sleep(1)
                            
            except Exception as e:
                error_text = str(e)
                logger.warning(f"Error sending healthcheck, retrying... ({i+1}/3): {error_text}")
                await asyncio.sleep(1)
        
        # All retries failed, send telegram notification
        error_msg = f"Failed to send healthcheck after 3 retries: {error_text}"
        logger.error(error_msg)
        await send_error_to_telegram(
            error_message=error_msg,
            hotkey=self.hotkey_address,
            context="PlatformAPI.healthcheck"
        )
        return False
    
    async def upload_log(
        self,
        file_path: str,
        file_type: str,
    ) -> Dict[str, Any]:
        """
        Upload a log file or transcript file to platform.
        
        Args:
            file_path: Path to the file to upload
            file_type: Type of file ("log" or "transcript")
            
        Returns:
            Response dictionary with status and message
        """
        url = f"{self.platform_api_url}/api/v1/validator/upload_log"
        logger.info(f"Uploading {file_type} file: {file_path}")
        
        # Read file content once (outside retry loop)
        try:
            with open(file_path, 'rb') as f:
                file_content = f.read()
        except Exception as e:
            error_msg = f"Error reading file {file_path}: {str(e)}"
            logger.error(error_msg)
            await send_error_to_telegram(
                error_message=error_msg,
                hotkey=self.hotkey_address,
                context="PlatformAPI.upload_log",
                additional_info=f"File: {file_path}, Type: {file_type}"
            )
            return {
                "status": "error",
                "message": error_msg,
            }
        
        error_text = None
        
        # Retry 3 times
        for i in range(3):
            try:
                headers = self._build_auth_headers()
                
                # Prepare multipart form data
                form_data = aiohttp.FormData()
                form_data.add_field('file', file_content, filename=os.path.basename(file_path), content_type='application/octet-stream')
                form_data.add_field('file_type', file_type)
                form_data.add_field('filename', os.path.basename(file_path))
                form_data.add_field('file_size', str(len(file_content)))
                
                # Remove Content-Type from headers (aiohttp will set it with boundary)
                upload_headers = {k: v for k, v in headers.items() if k.lower() != 'content-type'}
                
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, headers=upload_headers, data=form_data) as response:
                        if response.status == 200:
                            data = await response.json()
                            logger.info(f"Successfully uploaded {file_type} file: {os.path.basename(file_path)}")
                            return data
                        else:
                            error_text = await response.text()
                            logger.warning(f"Failed to upload {file_type} file, retrying... ({i+1}/3): {response.status} - {error_text}")
                            # Don't send telegram notification on retry, only after all retries fail
                            await asyncio.sleep(1)
                            
            except Exception as e:
                error_text = str(e)
                logger.warning(f"Error uploading {file_type} file, retrying... ({i+1}/3): {error_text}")
                await asyncio.sleep(1)
        
        # All retries failed, send telegram notification
        error_msg = f"Failed to upload {file_type} file after 3 retries: {error_text}"
        logger.error(error_msg)
        await send_error_to_telegram(
            error_message=error_msg,
            hotkey=self.hotkey_address,
            context="PlatformAPI.upload_log",
            additional_info=f"File: {os.path.basename(file_path)}, Type: {file_type}"
        )
        return {
            "status": "error",
            "message": error_text,
        }

