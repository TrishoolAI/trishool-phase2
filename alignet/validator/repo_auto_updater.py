"""
Repository Auto Updater Script.

This script runs the RepoCommitChecker in a loop to automatically
monitor the repository and update/restart when new commits are detected.

Usage:
    python -m alignet.validator.repo_auto_updater
    # Or as a standalone script
    python alignet/validator/repo_auto_updater.py
"""

import asyncio
import os
import signal
import sys
from alignet.validator.repo_commit_checker import RepoCommitChecker
from alignet.validator.constants import TRISHOOL_COMMIT_CHECK_INTERVAL
from alignet.utils.logging import get_logger

logger = get_logger()


def _env_skip_startup_docker() -> bool:
    return os.environ.get("TRISHOOL_SKIP_STARTUP_DOCKER", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


class RepoAutoUpdater:
    """Auto updater that monitors repository and updates/restarts on new commits."""
    
    def __init__(self, check_interval: int = TRISHOOL_COMMIT_CHECK_INTERVAL):
        """
        Initialize the auto updater.
        
        Args:
            check_interval: Interval in seconds between checks
        """
        self.check_interval = check_interval
        self.commit_checker = RepoCommitChecker(check_interval=check_interval)
        self.running = False

    async def run(self):
        """Run the auto updater loop."""
        self.running = True
        logger.info(
            f"Repository Auto Updater started. "
            f"Checking every {self.check_interval} seconds..."
        )

        # When no new commit is detected, check_for_updates skips docker entirely.
        # Refresh the stack once per process start (no --build), same as a manual
        # pm2 restart expectation. Set TRISHOOL_SKIP_STARTUP_DOCKER=1 if PM2 already
        # runs docker-down.sh / docker-up.sh before this Python process (see ecosystem).
        if not _env_skip_startup_docker():
            logger.info(
                "Startup Docker refresh (docker-down.sh / docker-up.sh, no --build)..."
            )
            ok = await self.commit_checker.bash_restart_agent(rebuild_images=False)
            if not ok:
                logger.error(
                    "Startup Docker refresh failed; continuing with commit poll loop"
                )

        try:
            while self.running:
                try:
                    # Check for updates
                    await self.commit_checker.check_and_update()
                    
                    # Wait for next check
                    await asyncio.sleep(self.check_interval)
                    
                except asyncio.CancelledError:
                    logger.info("Auto updater loop cancelled")
                    break
                except Exception as e:
                    logger.error(f"Error in auto updater loop: {str(e)}")
                    # Continue running even if there's an error
                    await asyncio.sleep(self.check_interval)
                    
        except KeyboardInterrupt:
            logger.info("Auto updater interrupted by user")
        finally:
            self.running = False
            logger.info("Repository Auto Updater stopped")
    
    def start(self):
        """Start the auto updater."""
        try:
            asyncio.run(self.run())
        except KeyboardInterrupt:
            logger.info("Auto updater stopped by user")


async def main():
    """Main entry point for the auto updater."""
    updater = RepoAutoUpdater()
    await updater.run()


if __name__ == "__main__":
    updater = RepoAutoUpdater()
    updater.start()

