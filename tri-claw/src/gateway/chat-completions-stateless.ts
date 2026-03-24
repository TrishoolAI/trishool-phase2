import type { OpenClawConfig } from "../config/types.js";

const OFF: ResolvedGatewayChatCompletionsStateless = {
  enabled: false,
  ephemeralSession: false,
  skipSessionPersistence: false,
  protectWorkspaceStateFiles: false,
};

export type ResolvedGatewayChatCompletionsStateless = {
  enabled: boolean;
  ephemeralSession: boolean;
  skipSessionPersistence: boolean;
  /**
   * Merge default `tools.fs.protectedPaths` for persona/memory/bootstrap files (and Docker :ro submounts when sandboxed).
   * Default true when stateless mode is active.
   */
  protectWorkspaceStateFiles: boolean;
};

export function resolveGatewayChatCompletionsStateless(
  cfg: OpenClawConfig | undefined,
): ResolvedGatewayChatCompletionsStateless {
  const raw = cfg?.gateway?.http?.endpoints?.chatCompletions?.stateless;
  if (raw === undefined || raw === false) {
    return OFF;
  }
  if (raw === true) {
    return {
      enabled: true,
      ephemeralSession: true,
      skipSessionPersistence: true,
      protectWorkspaceStateFiles: true,
    };
  }
  if (raw.enabled === false) {
    return OFF;
  }
  return {
    enabled: true,
    ephemeralSession: raw.ephemeralSession !== false,
    skipSessionPersistence: raw.skipSessionPersistence !== false,
    protectWorkspaceStateFiles: raw.protectWorkspaceStateFiles !== false,
  };
}
