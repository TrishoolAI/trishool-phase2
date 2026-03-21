/**
 * PM2 Ecosystem Configuration for Repository Auto Updater
 * 
 * This configuration file manages the auto-updater service that monitors
 * the trishool-subnet repository for new commits and automatically pulls
 * and restarts the application.
 * 
 * Usage:
 *   pm2 start repo-auto-updater.config.js
 *   pm2 restart repo-auto-updater
 *   pm2 stop repo-auto-updater
 *   pm2 logs repo-auto-updater
 *   pm2 monit
 */

module.exports = {
  apps: [
    {
      name: "repo-auto-updater",
      script: "/Users/your_name/miniconda3/envs/alignnet/bin/python", // Change to your python environment
      args: ["-m", "alignet.validator.repo_auto_updater"],
      cwd: __dirname,
      autorestart: true,
      env: {
        GITHUB_TOKEN: "", // Your GitHub token
        TRISHOOL_REPO_BRANCH: "main",
        TRISHOOL_COMMIT_CHECK_INTERVAL: "300",
        PM2_APP_NAME: "trishool-subnet",
        PYTHONPATH: __dirname, 
      },
      
      // Advanced options
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
    }
  ]
};

