import type { OpenClawConfig } from "../../config/types.js";
import { DEFAULT_WORKSPACE_PROTECTED_REL_PATHS } from "../../agents/tool-protected-paths.js";

export function mergeStatelessHttpAgentConfig(
  cfg: OpenClawConfig,
  options?: { protectWorkspaceStateFiles?: boolean },
): OpenClawConfig {
  const protect = options?.protectWorkspaceStateFiles !== false;
  const defaults = cfg.agents?.defaults;
  const compactionPatch = {
    compaction: {
      ...defaults?.compaction,
      memoryFlush: {
        ...defaults?.compaction?.memoryFlush,
        enabled: false,
      },
    },
  };
  if (!protect) {
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...defaults,
          ...compactionPatch,
        },
      },
    };
  }
  const existingProtected = defaults?.tools?.fs?.protectedPaths ?? [];
  const mergedProtected = [
    ...new Set([
      ...DEFAULT_WORKSPACE_PROTECTED_REL_PATHS.map(String),
      ...existingProtected.map(String),
    ]),
  ];
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        ...compactionPatch,
        tools: {
          ...defaults?.tools,
          fs: {
            ...defaults?.tools?.fs,
            protectedPaths: mergedProtected,
          },
        },
      },
    },
  };
}
