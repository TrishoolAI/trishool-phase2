"""
Repository Commit Checker for Trishool Subnet.

This module checks for new commits on the trishool-subnet repository,
pulls the latest changes, and restarts the application using PM2.
"""

import asyncio
import subprocess
import os
from typing import Optional
from alignet.validator.base_commit_checker import BaseCommitChecker
from alignet.validator.constants import (
    TRISHOOL_REPO_OWNER,
    TRISHOOL_REPO_NAME,
    TRISHOOL_REPO_BRANCH,
    TRISHOOL_COMMIT_CHECK_INTERVAL,
    REPO_LOCAL_PATH,
    GIT_PULL_TIMEOUT,
    GIT_PULL_RETRIES,
    PM2_APP_NAME,
    PM2_RESTART_TIMEOUT,
    PM2_RESTART_RETRIES,
)
from alignet.utils.logging import get_logger

logger = get_logger()


class RepoCommitChecker(BaseCommitChecker):
    """
    Checks for new commits on trishool-subnet repository,
    pulls latest changes, and restarts application via PM2.
    """
    
    def __init__(
        self,
        repo_local_path: str = REPO_LOCAL_PATH,
        check_interval: int = TRISHOOL_COMMIT_CHECK_INTERVAL
    ):
        """
        Initialize the commit checker.
        
        Args:
            repo_local_path: Local path to the repository (default: project root)
            check_interval: Interval in seconds between checks (default: 5 minutes)
        """
        super().__init__(
            repo_owner=TRISHOOL_REPO_OWNER,
            repo_name=TRISHOOL_REPO_NAME,
            repo_branch=TRISHOOL_REPO_BRANCH,
            check_interval=check_interval
        )
        self.repo_local_path = os.path.abspath(repo_local_path)
        
        # Verify repository path exists
        if not os.path.exists(self.repo_local_path):
            logger.warning(
                f"Repository path does not exist: {self.repo_local_path}. "
                "Git pull operations may fail."
            )
        else:
            logger.info(f"Repository local path: {self.repo_local_path}")
    
    async def git_pull(self) -> bool:
        """
        Pull latest changes from the repository.
        
        Returns:
            True if pull was successful, False otherwise
        """
        if not os.path.exists(self.repo_local_path):
            logger.error(f"Repository path does not exist: {self.repo_local_path}")
            return False
        
        try:
            logger.info(f"Pulling latest changes from {self.repo_owner}/{self.repo_name}...")
            
            # Change to repository directory
            process = await asyncio.create_subprocess_exec(
                "git",
                "pull",
                "origin",
                self.repo_branch,
                cwd=self.repo_local_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=GIT_PULL_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.error(f"Git pull timed out after {GIT_PULL_TIMEOUT} seconds")
                process.kill()
                await process.wait()
                return False
            
            if process.returncode == 0:
                output = stdout.decode().strip()
                logger.info(f"Git pull successful: {output}")
                return True
            else:
                error = stderr.decode().strip()
                logger.error(f"Git pull failed: {error}")
                return False
                
        except Exception as e:
            logger.error(f"Error during git pull: {str(e)}")
            return False
    
    async def pm2_restart(self) -> bool:
        """
        Restart the application using PM2.
        
        Returns:
            True if restart was successful, False otherwise
        """
        try:
            logger.info(f"Restarting PM2 application: {PM2_APP_NAME}...")
            
            process = await asyncio.create_subprocess_exec(
                "pm2",
                "restart",
                PM2_APP_NAME,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=PM2_RESTART_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.error(f"PM2 restart timed out after {PM2_RESTART_TIMEOUT} seconds")
                process.kill()
                await process.wait()
                return False
            
            if process.returncode == 0:
                output = stdout.decode().strip()
                logger.info(f"PM2 restart successful: {output}")
                return True
            else:
                error = stderr.decode().strip()
                logger.error(f"PM2 restart failed: {error}")
                return False
                
        except FileNotFoundError:
            logger.error("PM2 command not found. Please install PM2: npm install -g pm2")
            return False
        except Exception as e:
            logger.error(f"Error during PM2 restart: {str(e)}")
            return False
    
    async def on_commit_detected(self, commit_hash: str) -> bool:
        """
        Handle new commit detection by pulling changes and restarting via PM2.
        
        Args:
            commit_hash: The new commit hash
            
        Returns:
            True if update was successful, False otherwise
        """
        try:
            logger.info(
                f"New commit detected for {self.repo_owner}/{self.repo_name}! "
                f"Pulling changes and restarting application..."
            )
            
            # Step 1: Pull latest changes
            pull_success = False
            for attempt in range(1, GIT_PULL_RETRIES + 1):
                logger.info(f"Git pull attempt {attempt}/{GIT_PULL_RETRIES}")
                pull_success = await self.git_pull()
                if pull_success:
                    break
                if attempt < GIT_PULL_RETRIES:
                    await asyncio.sleep(2)  # Wait before retry
            
            if not pull_success:
                logger.error("Failed to pull latest changes after all retries")
                return False
            
            # Step 2: Restart application via PM2
            restart_success = False
            for attempt in range(1, PM2_RESTART_RETRIES + 1):
                logger.info(f"PM2 restart attempt {attempt}/{PM2_RESTART_RETRIES}")
                restart_success = await self.pm2_restart()
                if restart_success:
                    break
                if attempt < PM2_RESTART_RETRIES:
                    await asyncio.sleep(2)  # Wait before retry
            
            if not restart_success:
                logger.error("Failed to restart application via PM2 after all retries")
                return False
            
            logger.info(
                f"Successfully updated and restarted application for commit {commit_hash[:8]}"
            )
            return True
            
        except Exception as e:
            logger.error(f"Error handling commit detection: {str(e)}")
            return False
    
    async def check_and_update(self) -> bool:
        """
        Check for new commits and trigger update if needed.
        
        Returns:
            True if update was triggered, False otherwise
        """
        return await super().check_and_update()

