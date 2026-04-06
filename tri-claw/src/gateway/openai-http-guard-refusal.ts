import type { OpenClawConfig } from "../config/types.js";

/** Matches guard-model `DEFAULT_REFUSAL_TEXT` after normalize (prefix check). */
const BUILTIN_REFUSAL_PREFIXES = [
  "blocked by guard model",
  "blocked by guard model: probable prompt injection detected",
] as const;

function normalizeRefusalPrefix(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.:]+$/u, "");
}

/**
 * Prefixes for guard policy blocks (HTTP 200 assistant text), not operational failures (502).
 * Uses lean/plugin `refusalText` when set, plus built-ins from guard-model defaults.
 */
export function collectGuardRefusalPrefixes(cfg: OpenClawConfig): string[] {
  const seen = new Set<string>();
  const rawConfig = cfg.plugins?.entries?.["guard-model"]?.config;
  const configured =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>).refusalText
      : undefined;
  const configuredStr =
    typeof configured === "string" ? configured.trim() : configured != null ? String(configured).trim() : "";
  if (configuredStr) {
    seen.add(normalizeRefusalPrefix(configuredStr));
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
