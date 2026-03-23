"""
Repository Commit Checker for Trishool Subnet.

This module checks for new commits on the trishool-subnet repository,
pulls the latest changes, and restarts the application using PM2.
"""

import asyncio
import os
import re
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
    DOCKER_AGENT_RESTART_TIMEOUT,
)
from alignet.utils.logging import get_logger

logger = get_logger()

# Written after a successful on_commit_detected; survives PM2 restarts.
LAST_APPLIED_COMMIT_FILE = ".trishool-last-applied-commit"
_GIT_REF_SAFE = re.compile(r"^[A-Za-z0-9_./@^{}-]+$")


def _normalize_sha(s: Optional[str]) -> str:
    if not s:
        return ""
    return s.strip().lower()[:40]


def _sha_equal(a: Optional[str], b: Optional[str]) -> bool:
    """Compare full or short SHAs (GitHub vs local)."""
    x, y = _normalize_sha(a), _normalize_sha(b)
    if not x or not y:
        return False
    if x == y:
        return True
    return x.startswith(y) or y.startswith(x) or x[:7] == y[:7]


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

        self._load_persisted_last_commit()

    def _persist_file_path(self) -> str:
        return os.path.join(self.repo_local_path, LAST_APPLIED_COMMIT_FILE)

    def _load_persisted_last_commit(self) -> None:
        path = self._persist_file_path()
        if not os.path.isfile(path):
            return
        try:
            with open(path, encoding="utf-8") as f:
                h = f.read().strip()
            if len(h) >= 7:
                self.last_commit_hash = _normalize_sha(h) or h.strip().lower()
                logger.info(
                    f"Restored last-applied commit from {LAST_APPLIED_COMMIT_FILE}: "
                    f"{self.last_commit_hash[:8]}"
                )
        except OSError as e:
            logger.warning(f"Could not read {path}: {e}")

    def _persist_last_commit(self, commit_hash: str) -> None:
        path = self._persist_file_path()
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(_normalize_sha(commit_hash) + "\n")
        except OSError as e:
            logger.warning(f"Could not write {path}: {e}")

    async def _git_rev_parse(self, ref: str) -> Optional[str]:
        if not _GIT_REF_SAFE.match(ref):
            return None
        git_dir = os.path.join(self.repo_local_path, ".git")
        if not os.path.isdir(git_dir):
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                ref,
                cwd=self.repo_local_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(
                proc.communicate(),
                timeout=min(30, GIT_PULL_TIMEOUT),
            )
            if proc.returncode != 0:
                return None
            out = stdout.decode().strip()
            return out if out else None
        except (asyncio.TimeoutError, Exception) as e:
            logger.debug(f"git rev-parse {ref!r} failed: {e}")
            return None

    async def _local_matches_remote_tip(self, latest_commit: str) -> bool:
        """True if HEAD or origin/<branch> matches GitHub tip (normalized)."""
        for ref in (
            "HEAD",
            f"refs/remotes/origin/{self.repo_branch}",
            f"origin/{self.repo_branch}",
        ):
            h = await self._git_rev_parse(ref)
            if h and _sha_equal(h, latest_commit):
                return True
        return False

    async def check_for_updates(self) -> bool:
        """
        Like :meth:`BaseCommitChecker.check_for_updates`, but after a process restart
        ``last_commit_hash`` is None. If local ``HEAD`` already matches the remote
        tip, we set the baseline and return False so we do not re-run pull/docker/pm2.
        """
        try:
            raw_latest = await self.get_latest_commit_hash()
            if not raw_latest:
                logger.warning(
                    f"Could not fetch latest commit hash for {self.repo_owner}/{self.repo_name}, "
                    "skipping check"
                )
                return False

            latest_commit = _normalize_sha(raw_latest)

            if self.last_commit_hash is None:
                if await self._local_matches_remote_tip(latest_commit):
                    self.last_commit_hash = latest_commit
                    logger.info(
                        f"Commit baseline aligned (local ref matches remote): {latest_commit[:8]}"
                    )
                    return False
                local_head = await self._git_rev_parse("HEAD")
                if not local_head:
                    self.last_commit_hash = latest_commit
                    logger.info(
                        f"Commit baseline from remote only (no local git): {latest_commit[:8]}"
                    )
                    return False

            if self.last_commit_hash is None or not _sha_equal(
                self.last_commit_hash, latest_commit
            ):
                logger.info(
                    f"New commit detected for {self.repo_owner}/{self.repo_name}! "
                    f"Old: {self.last_commit_hash[:8] if self.last_commit_hash else 'None'}, "
                    f"New: {latest_commit[:8]}"
                )
                self.last_commit_hash = latest_commit
                return True
            logger.debug(
                f"No new commits for {self.repo_owner}/{self.repo_name} "
                f"(current: {latest_commit[:8]})"
            )
            return False

        except Exception as e:
            logger.error(f"Error in check_for_updates: {str(e)}")
            return False

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
    
    async def pm2_restart_validator(self) -> bool:
        """
        ``pm2 restart`` on the validator app. The PM2 ecosystem file should run
        ``docker-down.sh`` / ``docker-up.sh`` (no ``--build``) before starting
        Python (e.g. ``bash -c 'cd repo && ./docker-down.sh && ./docker-up.sh && exec python …'``).

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


    async def _run_bash_script(
        self,
        script_relative: str,
        *,
        script_args: tuple[str, ...] = (),
        timeout: int = DOCKER_AGENT_RESTART_TIMEOUT,
    ) -> bool:
        """
        Run a bash script at repo root (docker-down.sh / docker-up.sh style).
        Uses asyncio subprocess + timeout; logs stdout/stderr on failure.

        Inherits only the current process environment (e.g. PM2 env); it does not
        parse repo-root ``.env`` files. Load env inside the shell script (e.g.
        ``docker compose --env-file``) or export vars in the PM2 ecosystem.
        """
        script_path = os.path.join(self.repo_local_path, script_relative)
        if not os.path.isfile(script_path):
            logger.error(f"Script not found: {script_path}")
            return False

        args_desc = f"{script_relative}" + (f" {' '.join(script_args)}" if script_args else "")
        logger.info(f"Running {args_desc} (cwd={self.repo_local_path}, timeout={timeout}s)")
        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                script_path,
                *script_args,
                cwd=self.repo_local_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                logger.error(
                    f"{script_relative} timed out after {timeout}s; terminating process"
                )
                process.kill()
                await process.wait()
                return False

            out = (stdout or b"").decode(errors="replace").strip()
            err = (stderr or b"").decode(errors="replace").strip()
            if process.returncode == 0:
                if out:
                    tail = "..." if len(out) > 2000 else ""
                    logger.info(f"{script_relative} stdout: {out[:2000]}{tail}")
                return True

            logger.error(
                f"{script_relative} failed (exit {process.returncode}). "
                f"stderr: {err[:4000] or '(empty)'}"
            )
            if out:
                logger.error(f"{script_relative} stdout: {out[:2000]}")
            return False

        except FileNotFoundError:
            logger.error("bash not found in PATH")
            return False
        except Exception as e:
            logger.error(f"Error running {script_relative}: {e}")
            return False

    async def bash_restart_agent(self, *, rebuild_images: bool = False) -> bool:
        """
        Restart tri-claw / tri-judge Docker stacks via repo-root scripts.

        Order: docker-down.sh then docker-up.sh (down must succeed before up).

        Use ``rebuild_images=True`` after ``git pull`` so ``docker-up.sh`` gets
        ``--build``. Manual ``pm2 restart`` relies on the PM2 config to run
        ``docker-down.sh`` / ``docker-up.sh`` without ``--build`` before Python.
        """
        down_ok = await self._run_bash_script("docker-down.sh")
        if not down_ok:
            logger.error("docker-down.sh failed; skipping docker-up.sh")
            return False

        up_args: tuple[str, ...] = ("--build",) if rebuild_images else ()
        up_ok = await self._run_bash_script("docker-up.sh", script_args=up_args)
        if not up_ok:
            logger.error("docker-up.sh failed")
            return False

        return True

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
                    await asyncio.sleep(5)  # Wait before retry
            
            if not pull_success:
                logger.error("Failed to pull latest changes after all retries")
                return False

            # Step 2: Rebuild and restart Docker agent stack (tri-claw + tri-judge).
            # Pass --build so images match the pulled code (PM2 typically runs down/up
            # without --build on each restart; autoupdate must rebuild after git pull).
            restart_agent_success = False
            for attempt in range(1, PM2_RESTART_RETRIES + 1):
                logger.info(
                    f"Docker agent restart attempt {attempt}/{PM2_RESTART_RETRIES} "
                    f"(docker-down.sh / docker-up.sh --build)"
                )
                restart_agent_success = await self.bash_restart_agent(rebuild_images=True)
                if restart_agent_success:
                    break
                if attempt < PM2_RESTART_RETRIES:
                    await asyncio.sleep(2)  # Wait before retry

            # Step 3: pm2 restart (ecosystem runs docker-down/up without --build before Python)
            restart_success = False
            for attempt in range(1, PM2_RESTART_RETRIES + 1):
                logger.info(f"PM2 restart attempt {attempt}/{PM2_RESTART_RETRIES}")
                restart_success = await self.pm2_restart_validator()
                if restart_success:
                    logger.info("PM2 restart validator successful")
                    break
                if attempt < PM2_RESTART_RETRIES:
                    await asyncio.sleep(2)  # Wait before retry

            if not restart_agent_success or not restart_success:
                logger.error(
                    "Failed to restart validator (PM2) and/or Docker agents after all retries"
                )
                return False
            
            logger.info(
                f"Successfully updated and restarted validator and agent applications for commit {commit_hash[:8]}"
            )
            self._persist_last_commit(commit_hash)
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

