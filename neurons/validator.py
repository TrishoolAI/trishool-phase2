# The MIT License (MIT)
# Copyright © 2023 Yuma Rao
# Copyright © 2024 Alignet Subnet

# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
# and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.

# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
# THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

import asyncio
import logging
import time
import os
import sys
import json
import random
import aiohttp
import re
import traceback
import numpy as np
import hashlib
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any


# Add the project root directory to Python path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

# Bittensor
import bittensor as bt
import dotenv

dotenv.load_dotenv()
# import base validator class which takes care of most of the boilerplate
from alignet.base.validator import BaseValidatorNeuron

# Alignet Subnet imports
from alignet.validator.agent_client import AgentClient
from alignet.validator.eval_ground_truth import (
    collect_redaction_strings_from_ground_truth,
    load_ground_truth_questions,
    resolve_ground_truth_path,
)
from alignet.validator.platform_api_client import PlatformAPIClient
from alignet.models.submission import MinerSubmission
from alignet.utils.telegram import send_error_safe
from alignet.utils.logging import get_logger
logger = get_logger()


def _first_agent_base_url(default: str, *env_keys: str) -> str:
    """First non-empty env value (comma-separated lists use the first URL)."""
    for key in env_keys:
        raw = os.getenv(key)
        if raw and raw.strip():
            first = raw.split(",")[0].strip()
            if first:
                return first
    return default


class Validator(BaseValidatorNeuron):
    """
    Alignet Subnet Validator.
    
    This validator:
    1. Calls platform REST API to fetch miner submissions
    2. Randomly selects submissions to evaluate
    3. Calls tri-claw agent container via HTTP to process evaluation
    4. Calls judge agent container via HTTP with tri-claw output to get evaluation results and scores
    5. Submits scores back to platform via REST API
    6. Calls single tri-claw and judge agent containers per configured URL
    """

    def __init__(self, config=None):
        super(Validator, self).__init__(config=config)

        logger.info("Loading Alignet Validator state...")
        self.load_state()

        
        # Initialize REST API client for platform communication
        platform_api_url = os.getenv("PLATFORM_API_URL", "https://api.trishool.ai")
        coldkey_name = self.config.wallet.name
        hotkey_name = self.config.wallet.hotkey
        network = self.config.subtensor.network
        netuid = self.config.netuid
        self.api_client = PlatformAPIClient(
            platform_api_url=platform_api_url,
            coldkey_name=coldkey_name,
            hotkey_name=hotkey_name,
            hotkey_address=self.wallet.hotkey.ss58_address,
            network=network,
            netuid=netuid
        )
        # Initialize Agent Client for HTTP calls to agent containers (single URL per agent)
        # Tri-claw (OpenClaw) auth: OPENCLAW_GATEWAY_PASSWORD or OPENCLAW_GATEWAY_TOKEN;
        # optional CHUTES_API_KEY and/or OPENROUTER_API_KEY (forwarded as X-* headers to chat/completions).
        # Judge LLM key: JUDGE_LLM_PROVIDER=chutes|openrouter (default chutes) picks which key is sent to tri-judge.
        # TRI_* / JUDGE_AGENT_* (PM2), or OPENCLAW_URL / JUDGE_URL (shared .env with tri-check README).
        # Defaults match docker-compose / validator.config.sample.js (gateway 18789, judge 8080).
        tri_claw_url = _first_agent_base_url(
            "http://localhost:18789",
            "TRI_CLAW_AGENT_URLS",
            "OPENCLAW_URL",
        )
        judge_url = _first_agent_base_url(
            "http://localhost:8080",
            "JUDGE_AGENT_URLS",
            "JUDGE_URL",
        )

        self.agent_client = AgentClient(
            tri_claw_base_url=tri_claw_url,
            judge_base_url=judge_url,
            # timeout=int(os.getenv("AGENT_REQUEST_TIMEOUT", "600")),
            timeout=200,
            health_check_interval=int(os.getenv("AGENT_HEALTH_CHECK_INTERVAL", "30")),
            max_retries=int(os.getenv("AGENT_MAX_RETRIES", "3")),
            retry_delay=float(os.getenv("AGENT_RETRY_DELAY", "1.0")),
        )

        # State tracking
        # Submissions currently in _evaluation_loop (skip if already processing; always cleared in finally)
        self.processing_submission_ids = set()
        self._processing_submissions_lock = asyncio.Lock()

        # Track uploaded files to avoid duplicates
        self.max_file_size_mb = 50  # Maximum file size to upload in MB
        
        # Configuration
        self.evaluation_interval = int(os.getenv("EVALUATION_INTERVAL", "30"))  # seconds
        self.update_weights_interval = 120  # 2 minutes default
        
        # Weight update loop state
        # self.weight_update_task: Optional[asyncio.Task] = None
        self.should_stop_weight_update = False
        # Start weight update loop as background task (runs independently)
        logger.info("Alignet Validator initialized successfully")
        self.latest_weight_update_timestamp = None

    async def concurrent_forward(self):
        """
        Run a single forward pass only.

        BaseValidatorNeuron.concurrent_forward() runs ``num_concurrent_forwards`` copies of
        ``forward()`` in parallel (asyncio.gather). Each copy would fetch the same evaluation
        input, see the same unscored questions in check_scoring_multi (before any submit lands),
        and spawn parallel per-question tasks — multiple workers then submit SUCCESS for the same
        question_id. Override keeps one evaluation pipeline per validator step.
        """
        await self.forward()

    async def forward(self):
        """
        Validator forward pass for Alignet Subnet.
        
        This method:
        - Starts background tasks for evaluation loop and score submission
        - Fetches submissions from platform API
        - Processes submissions by calling tri-claw and judge agents via HTTP
        - Submits scores back to platform
        - Starts weight update loop that runs independently every 2 minutes
        """
        try:
            # Start health checks (requires running event loop; deferred from __init__)
            # self.agent_client.start_health_checks()
            await self._evaluation_loop()
            logger.info("Evaluation loop completed")
            
            # Upload log files at the end of forward pass

            if self.latest_weight_update_timestamp is None or datetime.now() - self.latest_weight_update_timestamp > timedelta(seconds=self.update_weights_interval):
                logger.info("Updating weights, health checking and uploading logs")
                await self._update_weights()
                subnet_versions = await self.agent_client.fetch_subnet_versions()
                await self.api_client.healthcheck(subnet_versions=subnet_versions)
                await self._upload_logs()
                self.latest_weight_update_timestamp = datetime.now()

            await asyncio.sleep(self.evaluation_interval)
                    
        except Exception as e:
            logger.error(f"Validator forward pass failed: {str(e)}")
            raise
        finally:
            await self._cleanup()
    
    async def _evaluation_loop(self) -> None:
        """
        Process question-item pairs:
        1. Fetches evaluation input (challenge + submission) from platform API
        2. Matches challenge questions with submission_items by ID (Q1, Q2, etc.)
        3. Processes each question-item pair individually (can process in parallel)
        4. For each pair, checks if scoring exists before processing

        If ``submission_id`` is already in ``processing_submission_ids``, the loop returns
        immediately. The id is always removed in ``finally`` after a successful register,
        including on return, exception, or cancellation.
        """
        logger.info("Evaluation loop started")
        submission_id_locked: Optional[str] = None
        try:
            # Fetch evaluation input (challenge + submission)
            eval_input = await self.api_client.get_evaluation_inputs()
            if not eval_input:
                logger.info("No evaluation input available, sleeping for 20 seconds and trying again")
                time.sleep(20)
                return

            # Extract challenge and submission data
            challenge_data = eval_input.get("challenge", {})
            submission_data = eval_input.get("submission", {})

            if not challenge_data or not submission_data:
                logger.warning("Invalid evaluation input format")
                return

            submission_id = str(submission_data.get("id", "") or "").strip()
            if not submission_id:
                logger.warning("Evaluation input missing submission id")
                return

            async with self._processing_submissions_lock:
                if submission_id in self.processing_submission_ids:
                    logger.info(
                        "Skipping evaluation: submission %s is already being processed",
                        submission_id,
                    )
                    return
                self.processing_submission_ids.add(submission_id)
            submission_id_locked = submission_id

            questions = challenge_data.get("questions", [])
            submission_items = submission_data.get("submission_items", {})

            logger.info(f"Processing submission {submission_id} with {len(questions)} questions")

            # One entry per question_id (platform may list duplicates; parallel tasks would duplicate submits)
            question_item_pairs = []
            seen_question_ids = set()
            for question in questions:
                question_id = question.get("question_id")
                if not question_id or question_id not in submission_items:
                    logger.warning(f"Question {question_id} not found in submission_items")
                    continue
                if question_id in seen_question_ids:
                    logger.warning(
                        f"Duplicate question_id {question_id} in challenge.questions; using first entry only"
                    )
                    continue
                seen_question_ids.add(question_id)
                question_item_pairs.append((question, submission_items[question_id], question_id))
            
            if not question_item_pairs:
                logger.warning(f"No matching question-item pairs found for submission {submission_id}")
                return

            # Batch check which questions are already scored (one API call instead of N)
            challenge_id = challenge_data.get("id", "")
            all_question_ids = [qid for (_, _, qid) in question_item_pairs]
            multi_result = await self.api_client.check_scoring_multi(
                submission_id=submission_id,
                challenge_id=challenge_id,
                question_ids=all_question_ids,
            )
            unscored_set = set()

            if not multi_result:
                logger.warning("Skipping scoring for this submission because check_scoring_multi failed")
                return None

            unscored_set = set(multi_result.get("unscored_question_ids") or [])
            scored = multi_result.get("scored_question_ids") or []
            logger.info(f"Scoring for this submission {submission_id} with unscored question-item pairs: {unscored_set}")

            pairs_to_process = [
                (question, submission_item, question_id)
                for question, submission_item, question_id in question_item_pairs
                if question_id in unscored_set
            ]
            logger.info(f"Found {len(question_item_pairs)} question-item pairs, {len(pairs_to_process)} unscored to process")

            # Process only unscored question-item pairs (in parallel)
            for question, submission_item, question_id in pairs_to_process:
                await self._process_question_item_pair(
                        question=question,
                        submission_item=submission_item,
                        question_id=question_id,
                        submission_id=submission_id,
                        challenge_data=challenge_data,
                        submission_data=submission_data
                    )

        except Exception as e:
            logger.error(f"Fatal error in evaluation loop: {str(e)}")
            return None
        finally:
            if submission_id_locked:
                async with self._processing_submissions_lock:
                    self.processing_submission_ids.discard(submission_id_locked)
                logger.debug(
                    "Released processing lock for submission %s",
                    submission_id_locked,
                )

    async def _process_question_item_pair(
        self,
        question: Dict[str, Any],
        submission_item: Any,
        question_id: str,
        submission_id: str,
        challenge_data: Dict[str, Any],
        submission_data: Dict[str, Any],
    ) -> None:
        """
        Process a single question-item pair (only called for pairs not already scored; batch check is done in _evaluation_loop):
        1. Resolve prompt from submission_item
        2. Call tri-claw agent with prompt
        3. Call judge agent with tri-claw output
        4. Submit scoring with question_id

        Args:
            question: Question data from challenge
            submission_item: Submission item data (prompt/item for this question)
            question_id: Question ID (e.g., "Q1", "Q2")
            submission_id: Submission ID
            challenge_data: Full challenge data
            submission_data: Full submission data
        """

        gt_path = resolve_ground_truth_path(project_root)
        self._eval_ground_truth_questions = load_ground_truth_questions(gt_path)
        if self._eval_ground_truth_questions:
            logger.info(
                "Loaded eval ground truth for %s question(s) from %s",
                len(self._eval_ground_truth_questions),
                gt_path,
            )
            for secret in collect_redaction_strings_from_ground_truth(gt_path):
                if secret and secret not in self.agent_client._secret_values:
                    self.agent_client._secret_values.append(secret)

            ## save to json file for debugging
            os.makedirs("outputs", exist_ok=True)
            with open(f"outputs/eval_ground_truth_questions.json", "w") as f:
                json.dump(self._eval_ground_truth_questions, f, indent=4)
            logger.info(f"Saved eval ground truth questions to outputs/eval_ground_truth_questions.json")
        else:
            logger.info("No eval ground truth file at %s (judge uses platform question fields)", gt_path)
            return None
        try:
            challenge_id = challenge_data.get("id", "")
            # Scoring existence was already batch-checked in _evaluation_loop; only unscored pairs are processed here.

            # Step 1: Resolve prompt from submission_item (dict with "prompt" key or raw string)
            prompt = submission_item if isinstance(submission_item, str) else (submission_item.get("prompt") or "")
            if not prompt:
                logger.warning(f"Empty prompt for question {question_id}, skipping")
                await self._submit_failed_evaluation_for_question(
                    question_id=question_id,
                    submission_id=submission_id,
                    challenge_id=challenge_id,
                    error_message="Empty prompt in submission_item",
                )
                return
            
            surface_area = submission_data.get("surface_area", 1)
            
            # Step 3: Call tri-claw agent (OpenClaw-style: /v1/chat/completions with prompt)
            logger.info(f"Calling tri-claw agent for question {question_id}")
            try:
                openclaw_output = await self.agent_client.call_tri_claw_agent(
                    prompt=prompt,
                    submission_id=submission_id,
                )
                logger.info(f"Tri-claw agent completed for question {question_id}")

                # ## save to json file for debugging
                # os.makedirs("outputs", exist_ok=True)
                # with open(f"outputs/openclaw_output_submission_{submission_id[:10]}_question_{question_id}.json", "w") as f:
                #     json.dump(openclaw_output, f, indent=4)

            except Exception as e:
                error_msg = f"Tri-claw agent call failed for question {question_id}: {str(e)}"
                logger.error(error_msg)
                await self._submit_failed_evaluation_for_question(
                    question_id=question_id,
                    submission_id=submission_id,
                    challenge_id=challenge_id,
                    surface_area=surface_area,
                    error_message=error_msg,
                )
                return
            
            # Extract model response from tri-claw (OpenAI-style choices[0].message.content)
            model_response = ""
            if isinstance(openclaw_output, dict):
                choices = openclaw_output.get("choices") or []
                if choices and isinstance(choices[0], dict):
                    msg = choices[0].get("message") or {}
                    model_response = (msg.get("content") or "") if isinstance(msg, dict) else ""
            elif isinstance(openclaw_output, str):
                model_response = openclaw_output

            if not model_response or "HTTP 50" in model_response:
                logger.error(f"No model response for question {question_id}, skipping")
                await self._submit_failed_evaluation_for_question(
                    question_id=question_id,
                    submission_id=submission_id,
                    challenge_id=challenge_id,
                    surface_area=surface_area,
                    error_message=f"No model response from tri-claw agent or HTTP error: {model_response}",
                )
                return
            
            # Step 4: Call judge agent
            expected_safe = question.get("expected_safe_behavior") or ""
            expected_unsafe = question.get("expected_unsafe_output") or ""
            ground_truth_secrets = question.get("ground_truth_secrets")
            if ground_truth_secrets is not None and not isinstance(ground_truth_secrets, list):
                ground_truth_secrets = None
            gt_overlay = self._eval_ground_truth_questions.get(question_id)
            if gt_overlay is None and isinstance(question_id, str):
                gt_overlay = self._eval_ground_truth_questions.get(question_id.upper())
            if isinstance(gt_overlay, dict):
                o_secrets = gt_overlay.get("ground_truth_secrets")
                if isinstance(o_secrets, list):
                    ground_truth_secrets = o_secrets
                o_unsafe = gt_overlay.get("expected_unsafe_output")
                if isinstance(o_unsafe, str) and o_unsafe.strip():
                    expected_unsafe = o_unsafe
            logger.info(f"Calling judge agent for question {question_id}")
            try:
                judge_output = await self.agent_client.call_judge_agent(
                    question_id=question_id,
                    prompt=prompt,
                    model_response=model_response,
                    expected_safe_behavior=expected_safe,
                    expected_unsafe_output=expected_unsafe,
                    ground_truth_secrets=ground_truth_secrets,
                )
                logger.info(f"Judge agent completed for question {question_id}")
            except Exception as e:
                error_msg = f"Judge agent call failed for question {question_id}: {str(e)}"
                logger.error(error_msg)
                await self._submit_failed_evaluation_for_question(
                    question_id=question_id,
                    submission_id=submission_id,
                    challenge_id=challenge_id,
                    surface_area=surface_area,
                    error_message=error_msg,
                    openclaw_output=openclaw_output,
                    ground_truth=self._eval_ground_truth_questions
                )
                return

            if not isinstance(judge_output, dict) or "score" not in judge_output:
                logger.error(f"Judge output is not a dictionary and does not contain score for question {question_id}")
                await self._submit_failed_evaluation_for_question(
                    question_id=question_id,
                    submission_id=submission_id,
                    challenge_id=challenge_id,
                    surface_area=surface_area,
                    error_message=f"Judge output is not a dictionary and does not contain score for question {question_id}. This is response from judge agent: {judge_output}",
                    openclaw_output=openclaw_output,
                    ground_truth=self._eval_ground_truth_questions
                )
                return
            # Step 5: Submit scoring with question_id (include openclaw_output and judge_output)
            await self._submit_question_scoring(
                question_id=question_id,
                submission_id=submission_id,
                challenge_id=challenge_id,
                surface_area=surface_area,
                openclaw_output=openclaw_output,
                judge_output=judge_output,
                ground_truth=self._eval_ground_truth_questions
            )
            
        except Exception as e:
            logger.error(f"Error processing question {question_id} for submission {submission_id}: {str(e)}")
            await self._submit_failed_evaluation_for_question(
                question_id=question_id,
                submission_id=submission_id,
                challenge_id=challenge_data.get("id", ""),
                error_message=f"Exception during processing: {str(e)}",
                ground_truth=self._eval_ground_truth_questions
            )
    
    def _redact_payload(self, data: Any) -> Any:
        """Defense-in-depth: strip API keys/tokens from any payload before platform submission."""
        return self.agent_client._redact_secrets(data)

    async def _submit_failed_evaluation_for_question(
        self,
        question_id: str,
        submission_id: str,
        challenge_id: str,
        surface_area: int = 1,
        error_message: str = "",
        openclaw_output: Optional[Dict[str, Any]] = None,
        ground_truth: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Submit failed evaluation for a single question to platform.
        
        Args:
            question_id: Question ID (e.g., "Q1", "Q2")
            submission_id: Submission ID
            challenge_id: Challenge ID for this evaluation
            error_message: Error message describing the failure
            surface_area: Surface area version (1-5)
            openclaw_output: Tri-claw output if available (e.g. failed after tri-claw)
            ground_truth: Ground truth questions
        """
        try:
            logger.info(f"Submitting failed evaluation for question {question_id}, submission {submission_id}: {error_message}")
            
            request = {
                "submission_id": submission_id,
                "challenge_id": challenge_id,
                "timestamp": datetime.now().isoformat(),
                "surfaceArea": surface_area,
                "score": 0,
                "question_id": question_id,
                "evaluation_status": "failed",
                "errors": error_message,
                "judge_output": {
                    "score": 0,
                    "judgeVerdict": "failed",
                    "judgeReasoning": error_message,
                },
            }
            if openclaw_output:
                request["judge_output"]["openclaw_output"] = openclaw_output
            request["judge_output"]["ground_truth"] = ground_truth

            request = self._redact_payload(request)
            result = await self.api_client.submit_judge_output(
                submission_id=submission_id,
                judge_output=request,
            )
            
            logger.info(f"Successfully submitted failed_evaluation for question {question_id}: {result}")
                
        except Exception as e:
            logger.error(f"Error submitting failed_evaluation for question {question_id}: {str(e)}")
    
    async def _submit_question_scoring(
        self,
        question_id: str,
        submission_id: str,
        challenge_id: str,
        surface_area: int,
        openclaw_output: Dict[str, Any],
        judge_output: Dict[str, Any],
        ground_truth: Dict[str, Any] = {},
    ) -> None:
        """
        Submit scoring for a single question to platform, including tri-claw and judge outputs.
        
        Args:
            question_id: Question ID (e.g., "Q1", "Q2")
            submission_id: Submission ID
            challenge_id: Challenge ID for this evaluation
            surface_area: Surface area version (1-5)
            openclaw_output: Full tri-claw (OpenClaw) API response
            judge_output: Full judge API response (judgeVerdict, score, judgeReasoning)
            ground_truth: Ground truth questions
        """
        try:
            score = int(judge_output.get("score", 0)) if isinstance(judge_output.get("score"), (int, float)) else 0

            if not judge_output:
                judge_payload = {
                    "score": score,
                    "judgeVerdict": "failed",
                    "judgeReasoning": "Judge output is not a dictionary and does not contain score",
                }
            else:
                judge_payload = dict(judge_output)
            if openclaw_output:
                judge_payload["openclaw_output"] = openclaw_output

            judge_payload["ground_truth"] = ground_truth

            request = {
                "submission_id": submission_id,
                "challenge_id": challenge_id,
                "timestamp": datetime.now().isoformat(),
                "surfaceArea": surface_area,
                "score": score,
                "question_id": question_id,
                "evaluation_status": "SUCCESS",
                "judge_output": judge_payload,
                "ground_truth": ground_truth,
            }

            request = self._redact_payload(request)
            result = await self.api_client.submit_judge_output(
                submission_id=submission_id,
                judge_output=request,
            )
            
            if (result.get("status") or "").lower() == "success":
                logger.info(
                    f"Successfully submitted score_judge_output for question {question_id}, submission {submission_id} "
                    f"(score: {score})"
                )
            elif (result.get("status") or "").lower() == "skipped":
                logger.warning(
                    f"Scoring skipped for question {question_id}, submission {submission_id}: "
                    f"{result.get('message', 'A success scoring already exists.')}"
                )
            else:
                logger.warning(
                    f"Submit scoring returned non-success for question {question_id}: "
                    f"{result.get('message', 'Unknown error')}"
                )
            
        except Exception as e:
            logger.error(f"Error submitting scoring for question {question_id}: {str(e)}")


    async def _update_weights(self) -> None:
        """
        Fetches weights from platform API and sets them on chain.
        
        This method:
        1. Fetches weights from platform API
        2. Maps weights to metagraph uids using hotkeys
        3. Updates self.scores with platform weights
        4. Calls set_weights() to set weights on chain
        """
        logger.info("Updating weights from platform API")        
        try:
            # Sync metagraph first to ensure we have latest UID mappings
            self.resync_metagraph()
            logger.info("Synced metagraph, fetching weights from platform API")

            # Fetch weights from platform API
            platform_weights = await self.api_client.get_weights()
            logger.info(f"Platform weights: {platform_weights}")
            
            if platform_weights:
                # Map platform weights to metagraph uids
                self._apply_platform_weights_to_scores(platform_weights)
                # Set weights on chain immediately after updating scores
                self.set_weights()
                logger.info(f"Updated weights from platform for {len(platform_weights)} miners")
            else:
                logger.debug("No weights received from platform API")

        except Exception as e:
            logger.error(f"Error in update weights: {str(e)}")
    
    def _apply_platform_weights_to_scores(self, platform_weights: Dict[str, float]) -> None:
        """
        Map platform weights to metagraph uids and update self.scores.

        Platform weights dictionary keys can be either:
        - UID as string (e.g., "0", "1", "2")
        - Hotkey as string (resolved to UID via metagraph)

        Args:
            platform_weights: Dictionary mapping UID (string) or hotkey (string) to weight (float)
        """
        try:
            # Reset all scores to zero first
            self.scores.fill(0.0)

            for key, weight in platform_weights.items():
                uid = None
                try:
                    uid = int(key)
                except (ValueError, TypeError):
                    # Key may be hotkey: resolve to UID via metagraph
                    uid = self._hotkey_to_uid(key)
                if uid is not None and 0 <= uid < len(self.scores):
                    self.scores[uid] = float(weight)
                elif uid is not None:
                    logger.warning(f"UID {uid} out of range (metagraph.n={len(self.scores)})")

        except Exception as e:
            logger.error(f"Error applying platform weights to scores: {str(e)}")

    def _hotkey_to_uid(self, hotkey: str) -> Optional[int]:
        """Resolve hotkey to metagraph UID index. Returns None if not found."""
        if not hotkey or not hasattr(self, "metagraph") or self.metagraph is None:
            return None
        try:
            hotkeys = self.metagraph.hotkeys
            for i, hk in enumerate(hotkeys):
                if hk == hotkey:
                    return i
        except Exception:
            pass
        return None

    def _extract_timestamp_from_log_filename(self, filename: str) -> Optional[datetime]:
        """
        Extract timestamp from log filename.
        Formats:
        - events.log (current file, use file modification time)
        - events_2025-12-30_14-30-00.log (timestamp-based backup from RotatingFileHandler)
        
        Returns:
            datetime object or None if cannot extract
        """
        try:
            # Try to extract timestamp from filename: events_YYYY-MM-DD_HH-MM-SS.log
            # This matches the format created by _timestamp_namer in logging.py
            if '_' in filename and filename.endswith('.log'):
                # Remove .log extension
                name_without_ext = filename[:-4]
                # Split by underscore
                parts = name_without_ext.split('_')
                if len(parts) >= 3:
                    # Format: events_YYYY-MM-DD_HH-MM-SS
                    # parts = ['events', '2025-12-30', '14-30-00']
                    # Combine last two parts: YYYY-MM-DD_HH-MM-SS
                    date_time_str = f"{parts[-2]}_{parts[-1]}"
                    try:
                        return datetime.strptime(date_time_str, "%Y-%m-%d_%H-%M-%S")
                    except ValueError:
                        pass
                elif len(parts) >= 2:
                    # Fallback: try to parse as date only: YYYY-MM-DD
                    # This handles old format or edge cases
                    date_str = parts[-1]
                    try:
                        return datetime.strptime(date_str, "%Y-%m-%d")
                    except ValueError:
                        pass
            return None
        except Exception as e:
            logger.info(f"Failed to extract timestamp from {filename}: {e}")
            return None
    

    async def _upload_logs(self):
        """
        Upload log files to platform API.
        """
        try:
            logger.info("Starting log upload...")
            
            # Find files to upload
            log_files = self._find_log_files()
            
            # Upload log files
            for log_file in log_files:
                try:
                    result = await self.api_client.upload_log(str(log_file), "log")
                    if result.get("status") == "SUCCESS":
                        logger.info(f"Uploaded log file: {log_file.name}")
                        try:
                            ## delete log file after upload
                            log_file.unlink()
                            logger.info(f"Deleted log file: {log_file.name}")
                        except Exception as e:
                            logger.warning(f"Failed to delete log file {log_file.name}: {e}")
                    else:
                        logger.warning(f"Failed to upload log file {log_file.name}: {result.get('message', 'Unknown error')}")
                except Exception as e:
                    logger.warning(f"Failed to upload log file {log_file.name}: {e}")
                
            
        except Exception as e:
            logger.error(f"Error uploading logs: {e}")


    def _find_log_files(self) -> List[Path]:
        """
        Find log files in logs directory that need to be uploaded.
        """
        log_files = []
        # Use project_root from module level
        logs_dir = Path(project_root) / "logs"
        if not logs_dir.exists():
            logger.debug(f"Logs directory does not exist: {logs_dir}")
            return log_files
        
        # Find all .log files
        for log_file in logs_dir.rglob("*.log"):
            if not log_file.is_file():
                continue

            ## check if file is events.log, if so, skip
            if log_file.name == "events.log":
                continue
            
            # Check file size and add to list if it's less than max size (50MB)
            file_size = log_file.stat().st_size
            max_size_bytes = self.max_file_size_mb * 1024 * 1024
            if file_size <= max_size_bytes:
                log_files.append(log_file)
        return log_files
    
    
    async def _cleanup(self) -> None:
        """Cleanup resources."""
        try:
            # Stop weight update loop
            # Stop agent client health checks
            # if hasattr(self, 'agent_client'):
                # self.agent_client.stop_health_checks()

            logger.info("Validator cleanup completed")

        except Exception as e:
            logger.error(f"Error during cleanup: {str(e)}")
    
    def get_validator_status(self) -> Dict[str, Any]:
        """Get current validator status."""
        status = {
            "timestamp": datetime.now().isoformat()
        }
        if hasattr(self, 'agent_client'):
            status["agent_client"] = self.agent_client.get_status()
        return status


# The main function parses the configuration and runs the validator.
if __name__ == "__main__":
    with Validator() as validator:
        logger.info("Starting Alignet Subnet Validator...")
        while True:
            logger.info(f"\033[1;32m🟢 Validator running... {time.time()}\033[0m")
            time.sleep(200)
