import type { OpenClawConfig } from "../config/types.js";

const OFF: ResolvedGatewayChatCompletionsStateless = {
  enabled: false,
  ephemeralSession: false,
  denyWorkspaceWrites: false,
  skipSessionPersistence: false,
};

export type ResolvedGatewayChatCompletionsStateless = {
  enabled: boolean;
  ephemeralSession: boolean;
  denyWorkspaceWrites: boolean;
  skipSessionPersistence: boolean;
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
      denyWorkspaceWrites: true,
      skipSessionPersistence: true,
    };
  }
  if (raw.enabled === false) {
    return OFF;
  }
  return {
    enabled: true,
    ephemeralSession: raw.ephemeralSession !== false,
    denyWorkspaceWrites: raw.denyWorkspaceWrites !== false,
    skipSessionPersistence: raw.skipSessionPersistence !== false,
  };
}
