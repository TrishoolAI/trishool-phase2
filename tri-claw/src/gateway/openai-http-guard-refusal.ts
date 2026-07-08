import type { OpenClawConfig } from "../config/types.js";

/** Matches guard-model default refusal prefixes after normalize (prefix check). */
const BUILTIN_REFUSAL_PREFIXES = [
  "blocked by guard model",
  "blocked by guard model: probable prompt injection detected",
  "blocked by input guard model",
  "blocked by output guard model",
] as const;

function normalizeRefusalPrefix(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.:]+$/u, "");
}

function collectConfiguredRefusalTexts(rawConfig: unknown): string[] {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return [];
  }
  const cfg = rawConfig as Record<string, unknown>;
  const out: string[] = [];
  const push = (value: unknown) => {
    const text =
      typeof value === "string" ? value.trim() : value != null ? String(value).trim() : "";
    if (text) {
      out.push(text);
    }
  };
  push(cfg.refusalText);
  if (cfg.input && typeof cfg.input === "object" && !Array.isArray(cfg.input)) {
    push((cfg.input as Record<string, unknown>).refusalText);
  }
  if (cfg.output && typeof cfg.output === "object" && !Array.isArray(cfg.output)) {
    push((cfg.output as Record<string, unknown>).refusalText);
  }
  return out;
}

/**
 * Prefixes for guard policy blocks (HTTP 200 assistant text), not operational failures (502).
 * Uses lean/plugin `refusalText` (top-level and per-phase) when set, plus built-ins.
 */
export function collectGuardRefusalPrefixes(cfg: OpenClawConfig): string[] {
  const seen = new Set<string>();
  const rawConfig = cfg.plugins?.entries?.["guard-model"]?.config;
  for (const configured of collectConfiguredRefusalTexts(rawConfig)) {
    seen.add(normalizeRefusalPrefix(configured));
  }
  for (const p of BUILTIN_REFUSAL_PREFIXES) {
    seen.add(p);
  }
  return [...seen].filter(Boolean);
}

/** True when this payload text is an intentional guard refusal, not a transport/model failure. */
export function isGuardPolicyRefusalText(text: string, prefixes: readonly string[]): boolean {
  const t = text.trim().toLowerCase();
  if (!t) {
    return false;
  }
  return prefixes.some((p) => {
    if (!p) {
      return false;
    }
    return t.startsWith(p) || t.startsWith(`${p}.`) || t.startsWith(`${p}:`);
  });
}
