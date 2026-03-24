import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveToolFsWorkspaceOnly, resolveToolFsConfig } from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("uses agents.defaults.tools.fs.workspaceOnly between global and agent entry", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        defaults: {
          tools: { fs: { workspaceOnly: true } },
        },
        list: [{ id: "main" }],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });
});

describe("resolveToolFsConfig", () => {
  it("merges protectedPaths from global, agents.defaults, and agent entry", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { protectedPaths: ["a"] } },
      agents: {
        defaults: {
          tools: { fs: { protectedPaths: ["b"] } },
        },
        list: [
          {
            id: "main",
            tools: { fs: { protectedPaths: ["c"] } },
          },
        ],
      },
    };
    expect(resolveToolFsConfig({ cfg, agentId: "main" }).protectedPaths?.sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
