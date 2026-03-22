"""
Constants for commit checkers and repository management.
"""

import os

# GitHub API Configuration
GITHUB_API_BASE_URL = "https://api.github.com"
GITHUB_API_TIMEOUT = 10  # seconds
GITHUB_USER_AGENT = "Alignet-Subnet-Validator/1.0"
# Strip whitespace; PM2 / .env mistakes often add trailing newline or spaces → 401 Bad credentials
GITHUB_TOKEN = (os.getenv("GITHUB_TOKEN") or "").strip() or None

# Trishool Subnet Repository Configuration
TRISHOOL_REPO_OWNER = "TrishoolAI"
TRISHOOL_REPO_NAME = "trishool-phase2"
TRISHOOL_REPO_BRANCH = os.getenv("TRISHOOL_REPO_BRANCH", "main")  # Default to main branch
TRISHOOL_REPO_URL = f"https://github.com/{TRISHOOL_REPO_OWNER}/{TRISHOOL_REPO_NAME}.git"
TRISHOOL_COMMIT_CHECK_INTERVAL = int(os.getenv("TRISHOOL_COMMIT_CHECK_INTERVAL", "300"))  # 5 minutes default

# Git Configuration
GIT_PULL_TIMEOUT = 60  # seconds
GIT_PULL_RETRIES = 3

# PM2 Configuration
PM2_APP_NAME = os.getenv("PM2_APP_NAME", "trishool-subnet")
PM2_RESTART_TIMEOUT = 30  # seconds
PM2_RESTART_RETRIES = 3

# Docker tri-claw / tri-judge restart (docker-down.sh + docker-up.sh)
DOCKER_AGENT_RESTART_TIMEOUT = int(os.getenv("DOCKER_AGENT_RESTART_TIMEOUT", "100"))  # seconds

# Repository Local Path (for git pull)
# Default to project root (3 levels up from alignet/validator/constants.py)
_DEFAULT_REPO_PATH = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO_LOCAL_PATH = os.getenv("REPO_LOCAL_PATH", _DEFAULT_REPO_PATH)

