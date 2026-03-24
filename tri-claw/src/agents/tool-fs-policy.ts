import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
};

export function createToolFsPolicy(params: { workspaceOnly?: boolean }): ToolFsPolicy {
  return {
    workspaceOnly: params.workspaceOnly === true,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  protectedPaths?: string[];
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const defaultsFs = cfg?.agents?.defaults?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  const globalProtected = globalFs?.protectedPaths;
  const defaultsProtected = defaultsFs?.protectedPaths;
  const agentProtected = agentFs?.protectedPaths;
  const protectedPaths =
    agentProtected !== undefined ||
    defaultsProtected !== undefined ||
    globalProtected !== undefined
      ? [
          ...new Set(
            [...(globalProtected ?? []), ...(defaultsProtected ?? []), ...(agentProtected ?? [])]
              .map(String)
              .filter(Boolean),
          ),
        ]
      : undefined;
  return {
    workspaceOnly:
      agentFs?.workspaceOnly ?? defaultsFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    protectedPaths,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}
