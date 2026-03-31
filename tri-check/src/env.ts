import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Package root: tri-check/ */
export const TRI_CHECK_ROOT = path.resolve(__dirname, "..");

/** Default rubric when `--questions` is omitted (under this package). */
export const DEFAULT_QUESTIONS_PATH = path.join(TRI_CHECK_ROOT, "data", "questions.json");

/** Repo root: parent of tri-check/ */
export const REPO_ROOT = path.resolve(TRI_CHECK_ROOT, "..");

/**
 * Load env: tri-check/.env first, then repo-root .env.
 * Later files do not override existing process.env keys (dotenv default).
 */
export function loadEnvFiles(): void {
  dotenv.config({ path: path.join(TRI_CHECK_ROOT, ".env") });
  dotenv.config({ path: path.join(REPO_ROOT, ".env") });
}

export interface ResolvedServiceUrls {
  openclawUrl: string;
  judgeUrl: string;
  openclawToken: string;
  chutesApiKey: string;
}

export function resolveServiceUrls(overrides?: {
  openclawUrl?: string;
  judgeUrl?: string;
}): ResolvedServiceUrls {
  return {
    openclawUrl: (overrides?.openclawUrl ?? process.env.OPENCLAW_URL ?? "http://localhost:18789").replace(/\/$/, ""),
    judgeUrl: (overrides?.judgeUrl ?? process.env.JUDGE_URL ?? "http://localhost:8080").replace(/\/$/, ""),
    openclawToken:
      (process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.OPENCLAW_GATEWAY_TOKEN || "").trim(),
    chutesApiKey: (process.env.CHUTES_API_KEY || "").trim(),
  };
}

export function formatChutesKeyForLog(key: string): string {
  const k = (key || "").trim();
  if (!k) return "(empty — header omitted)";
  if (process.env.TRI_CHECK_REVEAL_CHUTES_KEY === "1" || process.env.EVAL_REVEAL_CHUTES_KEY === "1") {
    return k;
  }
  if (k.length <= 14) return `***redacted*** (len ${k.length})`;
  return `${k.slice(0, 8)}…${k.slice(-6)} (len ${k.length})`;
}

/**
 * Strip secret values (API keys, gateway tokens) from arbitrary strings.
 * Call on any data that may be logged, printed, or persisted.
 */
export function redactSecrets(
  text: string,
  urls: ResolvedServiceUrls,
  fixtureSecrets: string[] = [],
): string {
  let result = text;
  const all = [urls.chutesApiKey, urls.openclawToken, ...fixtureSecrets];
  for (const secret of all) {
    if (secret && secret.length > 0 && result.includes(secret)) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
}

/** Deep-walk an object replacing secret values in all string leaves. */
export function redactSecretsFromObject<T>(data: T, urls: ResolvedServiceUrls, fixtureSecrets: string[] = []): T {
  if (typeof data === "string") return redactSecrets(data, urls, fixtureSecrets) as T;
  if (Array.isArray(data)) return data.map((item) => redactSecretsFromObject(item, urls, fixtureSecrets)) as T;
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = redactSecretsFromObject(v, urls, fixtureSecrets);
    }
    return out as T;
  }
  return data;
}
