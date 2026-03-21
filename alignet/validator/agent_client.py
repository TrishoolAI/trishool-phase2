"""
Agent Client for HTTP requests to agent containers (tri-claw and judge).

Single URL per agent; optional health checking and retries.
"""

import asyncio
import aiohttp
from typing import Dict, Any, List, Optional
from enum import Enum
import os
from datetime import datetime

from alignet.utils.logging import get_logger

logger = get_logger()


class AgentType(Enum):
    """Agent container types."""
    TRI_CLAW = "tri-claw"
    JUDGE = "judge"


class AgentClient:
    """
    Client for HTTP requests to tri-claw and judge agent containers.
    One URL per agent type.
    """

    def __init__(
        self,
        tri_claw_base_url: str,
        judge_base_url: str,
        timeout: int = 600,
        health_check_interval: int = 30,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        """
        Initialize Agent Client.

        Args:
            tri_claw_base_url: Base URL for tri-claw agent (e.g. "http://tri-claw:8000")
            judge_base_url: Base URL for judge agent (e.g. "http://judge:8000")
            timeout: Request timeout in seconds
            health_check_interval: Interval for health checks in seconds
            max_retries: Maximum number of retries for failed requests
            retry_delay: Delay between retries in seconds
        """
        self.tri_claw_url = tri_claw_base_url.rstrip("/")
        self.judge_url = judge_base_url.rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self.health_check_interval = health_check_interval
        self.max_retries = max_retries
        self.retry_delay = retry_delay

        self.tri_claw_healthy = True
        self.judge_healthy = True

        # self.health_check_task: Optional[asyncio.Task] = None
        # self._should_stop_health_check = False

        self.openclaw_token = (
            (os.getenv("OPENCLAW_GATEWAY_PASSWORD") or os.getenv("OPENCLAW_GATEWAY_TOKEN") or "").strip()
        )
        self.chutes_api_key = (os.getenv("CHUTES_API_KEY") or "").strip()

        logger.info(
            f"AgentClient initialized: tri-claw={self.tri_claw_url}, judge={self.judge_url}"
        )

    def _tri_claw_headers(self) -> Dict[str, str]:
        """Build headers for OpenClaw/tri-claw requests."""
        headers = {"Content-Type": "application/json"}
        if self.openclaw_token:
            headers["Authorization"] = f"Bearer {self.openclaw_token}"
        if self.chutes_api_key:
            headers["X-Chutes-Api-Key"] = self.chutes_api_key
        return headers

    async def _health_check(self, url: str, agent_type: AgentType) -> bool:
        """Check health of an agent container."""
        try:
            endpoint = f"{url}/health"
            headers = {}
            if agent_type == AgentType.TRI_CLAW and (self.openclaw_token or self.chutes_api_key):
                headers = self._tri_claw_headers()
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as session:
                async with session.get(endpoint, headers=headers or None) as response:
                    return response.status == 200
        except Exception as e:
            logger.debug(f"Health check failed for {agent_type.value} at {url}: {e}")
            return False

    # async def _health_check_loop(self):
    #     """Background task to periodically check health of both agents."""
    #     logger.info("Starting health check loop")
    #     while not self._should_stop_health_check:
    #         try:
    #             self.tri_claw_healthy = await self._health_check(self.tri_claw_url, AgentType.TRI_CLAW)
    #             if not self.tri_claw_healthy:
    #                 logger.warning(f"Tri-claw at {self.tri_claw_url} is unhealthy")
    #             self.judge_healthy = await self._health_check(self.judge_url, AgentType.JUDGE)
    #             if not self.judge_healthy:
    #                 logger.warning(f"Judge at {self.judge_url} is unhealthy")
    #             await asyncio.sleep(self.health_check_interval)
    #         except asyncio.CancelledError:
    #             logger.info("Health check loop cancelled")
    #             break
    #         except Exception as e:
    #             logger.error(f"Error in health check loop: {e}")
    #             await asyncio.sleep(self.health_check_interval)
    #     logger.info("Health check loop stopped")

    # def start_health_checks(self):
    #     """Start background health check task."""
    #     if self.health_check_task is None or self.health_check_task.done():
    #         self._should_stop_health_check = False
    #         self.health_check_task = asyncio.create_task(self._health_check_loop())
    #         logger.info("Health check task started")

    # def stop_health_checks(self):
    #     """Stop background health check task."""
    #     self._should_stop_health_check = True
    #     if self.health_check_task and not self.health_check_task.done():
    #         self.health_check_task.cancel()
    #         logger.info("Health check task stopped")

    async def call_tri_claw_agent(
        self,
        prompt: str,
        submission_id: str,
    ) -> Dict[str, Any]:
        """
        Call tri-claw (OpenClaw) agent - OpenAI-style chat completions.

        Args:
            prompt: User prompt for the guard model
            submission_id: Submission ID for logging

        Returns:
            API response (e.g. choices[0].message.content)

        Raises:
            Exception: If all retries fail
        """
        endpoint = f"{self.tri_claw_url}/v1/chat/completions"
        payload = {
            "model": "openclaw:main",
            "messages": [{"role": "user", "content": prompt}],
        }
        headers = self._tri_claw_headers()

        logger.info(f"Calling tri-claw for submission {submission_id} at {self.tri_claw_url}")
        last_error = None
        for attempt in range(self.max_retries):
            try:
                async with aiohttp.ClientSession(timeout=self.timeout) as session:
                    async with session.post(endpoint, json=payload, headers=headers) as response:
                        if response.status == 200:
                            result = await response.json()
                            logger.info(
                                f"Tri-claw success for submission {submission_id} "
                                f"(attempt {attempt + 1})"
                            )
                            return result
                        error_text = await response.text()
                        last_error = f"HTTP {response.status}: {error_text}"
                        logger.warning(
                            f"Tri-claw failed (attempt {attempt + 1}/{self.max_retries}): {last_error}"
                        )
            except asyncio.TimeoutError:
                last_error = f"Request timeout after {self.timeout.total}s"
                logger.warning(f"Tri-claw timeout (attempt {attempt + 1}/{self.max_retries})")
            except Exception as e:
                last_error = str(e)
                logger.warning(f"Tri-claw error (attempt {attempt + 1}/{self.max_retries}): {e}")

            if attempt < self.max_retries - 1:
                await asyncio.sleep(self.retry_delay * (attempt + 1))

        error_msg = f"Tri-claw failed after {self.max_retries} attempts: {last_error}"
        logger.error(error_msg)
        raise Exception(error_msg)

    async def call_judge_agent(
        self,
        question_id: str,
        prompt: str,
        model_response: str,
        expected_safe_behavior: str = "",
        expected_unsafe_output: str = "",
        ground_truth_secrets: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Call judge agent to evaluate model response.

        Matches the contract used in run-eval-judge-only.js: question, prompt,
        modelResponse, toolCalls, expectedOutput; optionally groundTruthSecrets
        when the question defines exact strings the judge must verify for jailbreak.

        Args:
            question_id: Question ID (e.g. "Q1", "Q2")
            prompt: Original prompt
            model_response: Response from tri-claw
            expected_safe_behavior: Expected safe behavior for scoring
            expected_unsafe_output: Expected unsafe (jailbreak) output for scoring
            ground_truth_secrets: Optional list of exact strings judge must match
                for confirmed jailbreak (e.g. planted secrets from questions-v4).

        Returns:
            Dict with judgeVerdict, score, judgeReasoning, etc.

        Raises:
            Exception: If all retries fail
        """
        endpoint = f"{self.judge_url}/v1/judge/evaluate"
        expected_output_text = "\n".join([
            "Expected safe behavior:",
            expected_safe_behavior,
            "",
            "Expected unsafe (jailbreak) output:",
            expected_unsafe_output,
        ])
        payload: Dict[str, Any] = {
            "question": question_id,
            "prompt": prompt,
            "modelResponse": model_response,
            "toolCalls": [],
            "expectedOutput": expected_output_text,
        }
        if ground_truth_secrets and len(ground_truth_secrets) > 0:
            payload["groundTruthSecrets"] = ground_truth_secrets
        headers = {"Content-Type": "application/json"}

        logger.info(f"Calling judge for question {question_id} at {self.judge_url}")
        last_error = None
        for attempt in range(self.max_retries):
            try:
                async with aiohttp.ClientSession(timeout=self.timeout) as session:
                    async with session.post(endpoint, json=payload, headers=headers) as response:
                        if response.status == 200:
                            result = await response.json()
                            logger.info(
                                f"Judge success for question {question_id} (attempt {attempt + 1})"
                            )
                            return result
                        error_text = await response.text()
                        last_error = f"HTTP {response.status}: {error_text}"
                        logger.warning(
                            f"Judge failed (attempt {attempt + 1}/{self.max_retries}): {last_error}"
                        )
            except asyncio.TimeoutError:
                last_error = f"Request timeout after {self.timeout.total}s"
                logger.warning(f"Judge timeout (attempt {attempt + 1}/{self.max_retries})")
            except Exception as e:
                last_error = str(e)
                logger.warning(f"Judge error (attempt {attempt + 1}/{self.max_retries}): {e}")

            if attempt < self.max_retries - 1:
                await asyncio.sleep(self.retry_delay * (attempt + 1))

        error_msg = f"Judge failed after {self.max_retries} attempts: {last_error}"
        logger.error(error_msg)
        raise Exception(error_msg)

    def get_status(self) -> Dict[str, Any]:
        """Current status of agent client."""
        return {
            "tri_claw": {
                "url": self.tri_claw_url,
                "healthy": self.tri_claw_healthy,
            },
            "judge": {
                "url": self.judge_url,
                "healthy": self.judge_healthy,
            },
            "timestamp": datetime.now().isoformat(),
        }
