import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExecCommandAvoidsProtectedWorkspacePaths,
  buildProtectedWorkspaceDockerBinds,
  isWorkspacePathProtected,
  normalizeProtectedRelPath,
} from "./tool-protected-paths.js";

describe("tool-protected-paths", () => {
  it("normalizeProtectedRelPath rejects traversal", () => {
    expect(normalizeProtectedRelPath("../etc/passwd")).toBeNull();
    expect(normalizeProtectedRelPath("ok/memory")).toBe("ok/memory");
  });

  it("isWorkspacePathProtected matches files and prefixes", () => {
    const root = path.resolve("/tmp/ws");
    expect(
      isWorkspacePathProtected({
        workspaceRoot: root,
        absolutePath: path.join(root, "MEMORY.md"),
        protectedRels: ["MEMORY.md"],
      }),
    ).toBe(true);
    expect(
      isWorkspacePathProtected({
        workspaceRoot: root,
        absolutePath: path.join(root, "memory", "2026-01-01.md"),
        protectedRels: ["memory"],
      }),
    ).toBe(true);
    expect(
      isWorkspacePathProtected({
        workspaceRoot: root,
        absolutePath: path.join(root, "src", "main.ts"),
        protectedRels: ["memory"],
      }),
    ).toBe(false);
  });

  it("assertExecCommandAvoidsProtectedWorkspacePaths blocks literals", () => {
    const root = path.resolve("/workspace");
    expect(() =>
      assertExecCommandAvoidsProtectedWorkspacePaths({
        command: `cat ${path.join(root, "SOUL.md")}`,
        workspaceRoot: root,
        protectedRels: ["SOUL.md"],
      }),
    ).toThrow(/protected workspace path/i);
    expect(() =>
      assertExecCommandAvoidsProtectedWorkspacePaths({
        command: "echo hello",
        workspaceRoot: root,
        protectedRels: ["SOUL.md"],
      }),
    ).not.toThrow();
  });
});

describe("buildProtectedWorkspaceDockerBinds", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("emits ro bind only when host path exists", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prot-ws-"));
    dirs.push(base);
    const mem = path.join(base, "memory");
    fs.mkdirSync(mem, { recursive: true });
    const binds = buildProtectedWorkspaceDockerBinds({
      hostWorkspaceRoot: base,
      containerWorkdir: "/workspace",
      protectedRels: ["memory", "MISSING.md"],
    });
    expect(binds.length).toBe(1);
    expect(binds[0]).toContain(`${mem}:`);
    expect(binds[0]).toContain("/workspace/memory:ro");
  });
});
