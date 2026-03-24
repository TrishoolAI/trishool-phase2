import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
} from "./workspace.js";

/** Default workspace-relative paths treated as long-lived persona / memory / bootstrap state. */
export const DEFAULT_WORKSPACE_PROTECTED_REL_PATHS: readonly string[] = [
  "memory",
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;

export function normalizeProtectedRelPath(raw: string): string | null {
  const t = raw.trim().replace(/\\/g, "/");
  if (!t) {
    return null;
  }
  const posix = path.posix.normalize(t);
  if (posix.startsWith("..") || posix.startsWith("/") || posix.includes("\0")) {
    return null;
  }
  return posix.replace(/^\/+/, "");
}

export function isAbsolutePathUnderDirectory(rootDir: string, candidateAbs: string): boolean {
  const root = path.resolve(rootDir);
  const target = path.resolve(candidateAbs);
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True when `absolutePath` is inside `workspaceRoot` and its workspace-relative path matches
 * or extends a protected entry (prefix match for directories).
 */
export function isWorkspacePathProtected(params: {
  workspaceRoot: string;
  absolutePath: string;
  protectedRels: string[];
}): boolean {
  if (!params.protectedRels.length) {
    return false;
  }
  const root = path.resolve(params.workspaceRoot);
  const target = path.resolve(params.absolutePath);
  if (!isAbsolutePathUnderDirectory(root, target)) {
    return false;
  }
  const rel = path.relative(root, target).split(path.sep).join("/");
  for (const p of params.protectedRels) {
    const norm = normalizeProtectedRelPath(p);
    if (!norm) {
      continue;
    }
    if (rel === norm || rel.startsWith(`${norm}/`)) {
      return true;
    }
  }
  return false;
}

export function assertWorkspacePathNotProtected(params: {
  workspaceRoot: string;
  absolutePath: string;
  protectedRels: string[];
  label: string;
}): void {
  if (
    isWorkspacePathProtected({
      workspaceRoot: params.workspaceRoot,
      absolutePath: params.absolutePath,
      protectedRels: params.protectedRels,
    })
  ) {
    throw new Error(
      `${params.label}: path is protected (read-only): ${path.relative(params.workspaceRoot, path.resolve(params.absolutePath)) || "."}`,
    );
  }
}

/**
 * Extra Docker `-v` binds that mount protected workspace subtrees read-only on top of the main workspace mount.
 */
export function buildProtectedWorkspaceDockerBinds(params: {
  hostWorkspaceRoot: string;
  containerWorkdir: string;
  protectedRels: string[];
}): string[] {
  const binds: string[] = [];
  const hostRoot = path.resolve(params.hostWorkspaceRoot);
  const workdir = params.containerWorkdir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  for (const rel of params.protectedRels) {
    const norm = normalizeProtectedRelPath(rel);
    if (!norm) {
      continue;
    }
    const hostAbs = path.resolve(hostRoot, norm);
    if (!isAbsolutePathUnderDirectory(hostRoot, hostAbs) || path.resolve(hostAbs) === hostRoot) {
      continue;
    }
    try {
      if (!fs.existsSync(hostAbs)) {
        continue;
      }
    } catch {
      continue;
    }
    const containerPath = path.posix.join(workdir, ...norm.split("/"));
    binds.push(`${hostAbs}:${containerPath}:ro`);
  }
  return binds;
}

/**
 * Best-effort exec preflight: reject commands that contain obvious literal references to
 * protected workspace paths. Does not interpret shell variables or subshells.
 */
export function assertExecCommandAvoidsProtectedWorkspacePaths(params: {
  command: string;
  workspaceRoot: string;
  protectedRels: string[];
}): void {
  if (!params.protectedRels.length) {
    return;
  }
  const cmd = params.command;
  const root = path.resolve(params.workspaceRoot);
  const needles: string[] = [];
  for (const rel of params.protectedRels) {
    const norm = normalizeProtectedRelPath(rel);
    if (!norm) {
      continue;
    }
    const abs = path.resolve(root, norm);
    needles.push(abs);
    if (path.sep === "\\") {
      needles.push(abs.split(path.sep).join("/"));
    }
    needles.push(norm);
    needles.push(`./${norm}`);
    needles.push(`./${norm}/`);
    needles.push(`/${norm}`);
    needles.push(`/${norm}/`);
  }
  const seen = new Set<string>();
  for (const n of needles) {
    const t = n.trim();
    if (t.length < 2) {
      continue;
    }
    if (seen.has(t)) {
      continue;
    }
    seen.add(t);
    if (cmd.includes(t)) {
      throw new Error(
        `exec: command appears to reference a protected workspace path (${t}). Shell indirection may still bypass this check; use sandbox mode for kernel-enforced read-only mounts.`,
      );
    }
  }
}
