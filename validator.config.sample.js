/**
 * PM2 Ecosystem Configuration for Trishool Subnet
 * 
 * Usage:
 *   pm2 start validator.config.js
 *   pm2 restart trishool-subnet
 *   pm2 stop trishool-subnet
 *   pm2 logs trishool-subnet
 */

module.exports = {
  apps: [
    {
      name: "trishool-subnet",
      script: "neurons/validator.py",
      interpreter: "/Users/user_name/miniconda3/envs/alignnet/bin/python", // Change to your python environment
      autorestart: true,
      
      // Environment variables
      env: {
        PLATFORM_API_URL: "https://api.trishool.ai",
        EVALUATION_INTERVAL: 30,  // Interval to fetch submissions 
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
      args: ["--netuid", "23", "--subtensor.network", "finney", "--wallet.name", "your_wallet_name", "--wallet.hotkey", "your_hotkey_name"],
    }
  ]
};

