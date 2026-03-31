/**
 * PM2 Ecosystem Configuration for Repository Auto Updater
 * 
 * This configuration file manages the auto-updater service that monitors
 * the trishool-subnet repository for new commits and automatically pulls
 * and restarts the application.
 * 
 * Env vars: set in repo-root `.env` (e.g. GITHUB_TOKEN=...) or in your shell.
 * PM2 does not load `.env` by itself; this file reads it when PM2 parses the config.
 * 
 * Usage:
 *   pm2 start repo-auto-updater.config.js
 *   pm2 restart repo-auto-updater
 *   pm2 stop repo-auto-updater
 *   pm2 logs repo-auto-updater
 *   pm2 monit
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/** Minimal .env parser (no dotenv package). */
function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, "utf8");
  for (let line of text.split("\n")) {
    line = line.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      // Unquoted: `KEY=value # note` would otherwise break secrets (e.g. GitHub PAT)
      const commentAt = val.search(/\s+#/);
      if (commentAt !== -1) val = val.slice(0, commentAt).trim();
    }
    out[key] = val;
  }
  return out;
}

const rootEnv = loadEnvFile(path.join(__dirname, ".env"));
function pick(name, fallback = "") {
  const fromFile = rootEnv[name];
  if (fromFile !== undefined && String(fromFile).trim() !== "") return String(fromFile).trim();
  const fromShell = process.env[name];
  if (fromShell !== undefined && String(fromShell).trim() !== "") return String(fromShell).trim();
  return fallback;
}

const pm2Env = {
  GITHUB_TOKEN: pick("GITHUB_TOKEN", ""),
  TRISHOOL_REPO_BRANCH: pick("TRISHOOL_REPO_BRANCH", "main"),
  TRISHOOL_COMMIT_CHECK_INTERVAL: pick("TRISHOOL_COMMIT_CHECK_INTERVAL", "300"),
  PM2_APP_NAME: pick("PM2_APP_NAME", "trishool-subnet"),
  PYTHONPATH: __dirname,
};
const repoLocal = pick("REPO_LOCAL_PATH", "");
if (repoLocal) pm2Env.REPO_LOCAL_PATH = repoLocal;

/** Prefer PYTHON or PYTHON_BIN from .env / shell; else first `python3` / `python` on PATH. */
function resolvePythonInterpreter() {
  const explicit = pick("PYTHON", "") || pick("PYTHON_BIN", "");
  if (explicit) return explicit;
  try {
    const out = execSync("command -v python3", { encoding: "utf8" }).trim();
    if (out) return out;
  } catch (_) {
    /* ignore */
  }
  try {
    const out = execSync("command -v python", { encoding: "utf8" }).trim();
    if (out) return out;
  } catch (_) {
    /* ignore */
  }
  return "python3";
}

const pythonBin = resolvePythonInterpreter();

module.exports = {
  apps: [
    {
      name: "repo-auto-updater",
      script: pythonBin,
      args: ["-m", "alignet.validator.repo_auto_updater"],
      cwd: __dirname,
      autorestart: true,
      env: pm2Env,
      
      // Advanced options
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
    }
  ]
};

