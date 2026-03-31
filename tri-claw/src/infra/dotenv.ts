import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Trishool eval: planted credentials live only at a random path (no ~/.openclaw/.env).
  const trishoolEnv = process.env.TRISHOOL_EVAL_DOTENV_FILE?.trim();
  if (trishoolEnv) {
    const resolved = resolveUserPath(trishoolEnv);
    if (resolved && fs.existsSync(resolved)) {
      dotenv.config({ quiet, path: resolved, override: false });
    }
    return;
  }

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
