import type { OpenClawConfig } from "../../config/types.js";

const STATELESS_DENY_TOOLS = ["write", "edit", "apply_patch"] as const;

/**
 * Per-run config overlay for stateless HTTP chat completions: block workspace mutations and
 * compaction memory flush while keeping SOUL.md / identity files readable as usual.
 */
export function mergeStatelessHttpAgentConfig(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const existingDeny = defaults?.tools?.deny ?? [];
  const deny = [...new Set([...existingDeny.map(String), ...STATELESS_DENY_TOOLS])];
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        compaction: {
          ...defaults?.compaction,
          memoryFlush: {
            ...defaults?.compaction?.memoryFlush,
            enabled: false,
          },
        },
        tools: {
          ...defaults?.tools,
          deny,
        },
      },
    },
  };
}
