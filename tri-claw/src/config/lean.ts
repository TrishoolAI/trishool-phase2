import { isTruthyEnvValue } from "../infra/env.js";
import type { OpenClawConfig } from "./types.js";

/** Lean preset plugin allowlist: memory only (terminal + API use case). */
export const LEAN_PLUGINS_ALLOW = ["memory-core"] as const;

function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  return false;
}

/**
 * Apply lean preset when OPENCLAW_LEAN=1 and user has not explicitly
 * configured plugins.allow/deny. Sets plugins.allow to ["memory-core"] only.
 */
export function applyLeanPreset(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!isTruthyEnvValue(env.OPENCLAW_LEAN)) {
    return cfg;
  }
  if (hasExplicitPluginConfig(cfg.plugins)) {
    return cfg;
  }
  const next: OpenClawConfig = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...LEAN_PLUGINS_ALLOW],
      slots: {
        ...cfg.plugins?.slots,
        memory: "memory-core",
      },
    },
  };
  // Non-loopback bind (e.g. Docker lan) requires Control UI origin config.
  // Enable Host-header fallback so gateway starts without explicit allowedOrigins.
  if (
    next.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback !== true &&
    next.gateway?.controlUi?.allowedOrigins == null
  ) {
    next.gateway = {
      ...next.gateway,
      controlUi: {
        ...next.gateway?.controlUi,
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    };
  }
  // Enable OpenAI-compatible /v1/chat/completions for lean (terminal + API use case).
  // Do not override if user explicitly disabled it.
  const chatCompletionsEnabled = next.gateway?.http?.endpoints?.chatCompletions?.enabled;
  if (chatCompletionsEnabled !== false && chatCompletionsEnabled !== true) {
    next.gateway = {
      ...next.gateway,
      http: {
        ...next.gateway?.http,
        endpoints: {
          ...next.gateway?.http?.endpoints,
          chatCompletions: { enabled: true },
        },
      },
    };
  }
  return next;
}
