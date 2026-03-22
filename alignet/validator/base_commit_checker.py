"""
Base Commit Checker for repository monitoring.

This module provides a base class for checking commits on GitHub repositories.
"""

import asyncio
from abc import ABC, abstractmethod
from typing import Optional
import aiohttp
from alignet.utils.logging import get_logger
from alignet.validator.constants import (
    GITHUB_API_BASE_URL,
    GITHUB_API_TIMEOUT,
    GITHUB_USER_AGENT,
    GITHUB_TOKEN,
)

logger = get_logger()


class BaseCommitChecker(ABC):
    """Base class for checking commits on GitHub repositories."""
    
    def __init__(
        self,
        repo_owner: str,
        repo_name: str,
        repo_branch: str,
        check_interval: int = 300
    ):
        """
        Initialize the commit checker.
        
        Args:
            repo_owner: GitHub repository owner (e.g., "AstrowareAI")
            repo_name: GitHub repository name (e.g., "astro-petri")
            repo_branch: Branch to monitor (e.g., "main", "alignet")
            check_interval: Interval in seconds between checks (default: 5 minutes)
        """
        self.repo_owner = repo_owner
        self.repo_name = repo_name
        self.repo_branch = repo_branch
        self.check_interval = check_interval
        self.last_commit_hash: Optional[str] = None
        self.running = False
        self.check_task: Optional[asyncio.Task] = None
        
        logger.info(
            f"{self.__class__.__name__} initialized "
            f"(repo: {repo_owner}/{repo_name}, branch: {repo_branch}, "
            f"check interval: {check_interval}s)"
        )
        if GITHUB_TOKEN:
            logger.info("GitHub token found - using authenticated API requests (higher rate limit)")
        else:
            logger.info("No GitHub token - using unauthenticated API requests (60 req/h limit)")
    
    async def get_latest_commit_hash(self) -> Optional[str]:
        """
        Get the latest commit hash from the repository.
        
        Returns:
            Latest commit hash or None if failed
        """
        try:
            # Use GitHub API to get latest commit
            api_url = f"{GITHUB_API_BASE_URL}/repos/{self.repo_owner}/{self.repo_name}/commits/{self.repo_branch}"
            
            # GitHub API requires User-Agent header, otherwise returns 403
            headers = {
                "Accept": "application/vnd.github+json",
                "User-Agent": GITHUB_USER_AGENT,
            }
            
            # Add Authorization header if token is provided (for higher rate limits)
            if GITHUB_TOKEN:
                headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
            
            timeout = aiohttp.ClientTimeout(total=GITHUB_API_TIMEOUT)
            
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(api_url, headers=headers) as response:
                    if response.status == 200:
                        data = await response.json()
                        commit_hash = data.get("sha", "").strip()
                        if commit_hash:
                            logger.debug(f"Latest commit hash for {self.repo_owner}/{self.repo_name}: {commit_hash[:8]}")
                            return commit_hash
                    elif response.status == 403:
                        # Check if it's rate limiting
                        rate_limit_remaining = response.headers.get("X-RateLimit-Remaining")
                        rate_limit_reset = response.headers.get("X-RateLimit-Reset")
                        try:
                            error_text = await response.text()
                            error_preview = error_text[:200] if error_text else "N/A"
                        except:
                            error_preview = "Could not read response body"
                        logger.warning(
                            f"GitHub API returned 403 for {self.repo_owner}/{self.repo_name}. "
                            f"Rate limit remaining: {rate_limit_remaining}, "
                            f"Reset at: {rate_limit_reset}. "
                            f"Response: {error_preview}"
                        )
                        return None
                    else:
                        try:
                            error_text = await response.text()
                            error_preview = error_text[:200] if error_text else "N/A"
                        except:
                            error_preview = "Could not read response body"
                        logger.warning(
                            f"Failed to fetch commit hash for {self.repo_owner}/{self.repo_name}: "
                            f"HTTP {response.status}. Response: {error_preview}"
                        )
                        return None
                        
        except asyncio.TimeoutError:
            logger.error(
                f"Timeout while fetching latest commit hash from GitHub API "
                f"for {self.repo_owner}/{self.repo_name}"
            )
            return None
        except Exception as e:
            logger.error(
                f"Error fetching latest commit hash for {self.repo_owner}/{self.repo_name}: {str(e)}"
            )
            return None
    
    async def check_for_updates(self) -> bool:
        """
        Check for new commits.
        
        Returns:
            True if new commit detected, False otherwise
        """
        try:
            latest_commit = await self.get_latest_commit_hash()
            
            if not latest_commit:
                logger.warning(
                    f"Could not fetch latest commit hash for {self.repo_owner}/{self.repo_name}, "
                    "skipping check"
                )
                return False
            
            # Check if commit has changed
            if self.last_commit_hash is None or latest_commit != self.last_commit_hash:
                logger.info(
                    f"New commit detected for {self.repo_owner}/{self.repo_name}! "
                    f"Old: {self.last_commit_hash[:8] if self.last_commit_hash else 'None'}, "
                    f"New: {latest_commit[:8]}"
                )
                self.last_commit_hash = latest_commit
                return True
            else:
                logger.debug(
                    f"No new commits for {self.repo_owner}/{self.repo_name} "
                    f"(current: {latest_commit[:8]})"
                )
                return False
                
        except Exception as e:
            logger.error(f"Error in check_for_updates: {str(e)}")
            return False
    
    @abstractmethod
    async def on_commit_detected(self, commit_hash: str) -> bool:
        """
        Handle new commit detection.
        
        Args:
            commit_hash: The new commit hash
            
        Returns:
            True if handling was successful, False otherwise
        """
        pass
    
    async def check_and_update(self) -> bool:
        """
        Check for new commits and trigger update if needed.
        
        Returns:
            True if update was triggered, False otherwise
        """
        try:
            has_update = await self.check_for_updates()
            
            if has_update and self.last_commit_hash:
                return await self.on_commit_detected(self.last_commit_hash)
            
            return False
                
        except Exception as e:
            logger.error(f"Error in check_and_update: {str(e)}")
            return False

