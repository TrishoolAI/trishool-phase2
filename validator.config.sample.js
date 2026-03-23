/**
 * PM2 Ecosystem Configuration for Trishool Subnet
 *
 * Each start/restart runs docker-down.sh and docker-up.sh (no --build), then the validator.
 *
 * Usage:
 *   pm2 start validator.config.js
 *   pm2 restart trishool-subnet
 *   pm2 stop trishool-subnet
 *   pm2 logs trishool-subnet
 */

const path = require("path");

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const root = __dirname;
const pythonBin = "/Users/user_name/miniconda3/envs/alignnet/bin/python"; // change to your Python
const validatorPy = path.join(root, "neurons/validator.py");
const validatorArgs = [
  "--netuid",
  "23",
  "--subtensor.network",
  "finney",
  "--wallet.name",
  "your_wallet_name",
  "--wallet.hotkey",
  "your_hotkey_name",
];

const cmd = [
  "set -euo pipefail",
  `cd ${shQuote(root)}`,
  "./docker-down.sh",
  "./docker-up.sh",
  `export PYTHONPATH=${shQuote(root)}`,
  `exec ${shQuote(pythonBin)} ${shQuote(validatorPy)} ${validatorArgs.map(shQuote).join(" ")}`,
].join(" && ");

module.exports = {
  apps: [
    {
      name: "trishool-subnet",
      script: "/bin/bash",
      args: ["-c", cmd],
      cwd: root,
      autorestart: true,

      // Environment variables (passed to the bash process; child Python inherits them)
      env: {
        PYTHON_BIN: pythonBin,
        PLATFORM_API_URL: "https://apiv2.trishool.ai",
        EVALUATION_INTERVAL: 30, // Interval to fetch submissions
        TELEGRAM_BOT_TOKEN: "", // Telegram bot token for sending errors to Telegram
        TELEGRAM_CHANNEL_ID: "", // Telegram channel ID for sending errors to Telegram
        TRI_CLAW_AGENT_URLS: "http://localhost:18789",
        JUDGE_AGENT_URLS: "http://localhost:8080",
        AGENT_REQUEST_TIMEOUT: 600,
        AGENT_HEALTH_CHECK_INTERVAL: 30,
        AGENT_MAX_RETRIES: 3,
        AGENT_RETRY_DELAY: 1.0,
        OPENCLAW_GATEWAY_PASSWORD: "<your-gateway-password>",
        CHUTES_API_KEY: "<your-chutes-api-key>",
      },
    },
  ],
};
