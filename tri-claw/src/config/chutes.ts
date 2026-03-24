/**
 * Chutes provider config from environment variables.
 * When CHUTES_BASE_URL is set, merges Chutes provider and agent defaults into config.
 * Override via .env or Docker env: CHUTES_BASE_URL, CHUTES_DEFAULT_MODEL_ID,
 * CHUTES_DEFAULT_MODEL_REF, CHUTES_FAST_MODEL_ID, CHUTES_FAST_MODEL_REF, etc.
 */
import type { OpenClawConfig } from "./types.js";
import type { ModelDefinitionConfig } from "./types.models.js";

const DEFAULT_CHUTES_BASE_URL = "https://llm.chutes.ai/v1";

export type ChutesModelEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

/** Fetch models from Chutes API. Returns empty array if baseUrl unset or fetch fails. */
export async function fetchChutesModels(
  baseUrlOverride?: string,
  apiKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChutesModelEntry[]> {
  const { baseUrl: envBaseUrl } = resolveChutesEnv(env);
  const baseUrl = (baseUrlOverride ?? envBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return [];
  }
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey?.trim() ?? env.CHUTES_API_KEY?.trim();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const items = Array.isArray(data.data) ? data.data : [];
    return items.map((m) => {
      const rawId = typeof m.id === "string" || typeof m.id === "number" ? String(m.id) : "";
      const id = rawId.trim() || "unknown";
      return {
        id,
        name: id,
        provider: "chutes",
        contextWindow: typeof m.context_length === "number" ? m.context_length : undefined,
        reasoning: Array.isArray(m.supported_features)
          ? (m.supported_features as string[]).includes("reasoning")
          : undefined,
      };
    });
  } catch {
    return [];
  }
}
const DEFAULT_MODEL_ID = "zai-org/GLM-4.7-TEE";
const FAST_MODEL_ID = "zai-org/GLM-4.7-Flash";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function resolveChutesEnv(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  defaultModelId: string;
  defaultModelRef: string;
  fastModelId: string;
  fastModelRef: string;
} {
  const baseUrl = (env.CHUTES_BASE_URL ?? DEFAULT_CHUTES_BASE_URL).replace(/\/+$/, "");
  const defaultModelId = env.CHUTES_DEFAULT_MODEL_ID ?? DEFAULT_MODEL_ID;
  const defaultModelRef = env.CHUTES_DEFAULT_MODEL_REF ?? `chutes/${defaultModelId}`;
  const fastModelId = env.CHUTES_FAST_MODEL_ID ?? FAST_MODEL_ID;
  const fastModelRef = env.CHUTES_FAST_MODEL_REF ?? `chutes/${fastModelId}`;
  return { baseUrl, defaultModelId, defaultModelRef, fastModelId, fastModelRef };
}

function buildChutesModelDef(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name ?? params.id,
    reasoning: params.reasoning ?? false,
    input: params.input ?? ["text"],
    cost: DEFAULT_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function buildChutesProviderConfig(
  env: NodeJS.ProcessEnv,
): Record<string, import("./types.models.js").ModelProviderConfig> {
  const { baseUrl, defaultModelId, fastModelId } = resolveChutesEnv(env);

  const models: ModelDefinitionConfig[] = [
    buildChutesModelDef({
      id: defaultModelId,
      name: `Chutes ${defaultModelId.split("/").pop() ?? defaultModelId}`,
    }),
    buildChutesModelDef({
      id: fastModelId,
      name: `Chutes ${fastModelId.split("/").pop() ?? fastModelId}`,
    }),
  ];

  return {
    chutes: {
      baseUrl,
      api: "openai-completions",
      auth: "api-key",
      models,
    },
  };
}

function buildChutesAgentDefaults(
  env: NodeJS.ProcessEnv,
): Partial<NonNullable<OpenClawConfig["agents"]>["defaults"]> {
  const { defaultModelRef, fastModelRef } = resolveChutesEnv(env);

  const modelEntries: Record<string, { alias?: string }> = {};
  modelEntries["chutes-fast"] = { alias: fastModelRef };
  modelEntries["chutes-default"] = { alias: defaultModelRef };

  return {
    model: {
      primary: defaultModelRef,
      fallbacks: [],
    },
    models: modelEntries,
  };
}

/**
 * Apply Chutes provider and agent defaults from env when CHUTES_BASE_URL is set.
 * Env vars override any existing chutes config. Use CHUTES_API_KEY for auth.
 */
export function applyChutesFromEnv(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  // Apply when CHUTES_BASE_URL is explicitly set, or when CHUTES_API_KEY is set
  // (uses the default URL so the provider is always available when a key exists).
  const explicitBaseUrl = (env.CHUTES_BASE_URL ?? "").trim();
  const hasApiKey = (env.CHUTES_API_KEY ?? "").trim().length > 0;
  const hasModelEnvOverride =
    (env.CHUTES_DEFAULT_MODEL_ID ?? "").trim().length > 0 ||
    (env.CHUTES_DEFAULT_MODEL_REF ?? "").trim().length > 0 ||
    (env.CHUTES_FAST_MODEL_ID ?? "").trim().length > 0 ||
    (env.CHUTES_FAST_MODEL_REF ?? "").trim().length > 0;
  const hasConfiguredChutesProvider = Boolean(cfg.models?.providers?.chutes);
  if (!explicitBaseUrl && !hasApiKey) {
    return cfg;
  }
  // Allow API-key-only setups to keep JSON-defined model/fallback configuration
  // without being overwritten by env defaults.
  if (!explicitBaseUrl && hasApiKey && !hasModelEnvOverride && hasConfiguredChutesProvider) {
    return cfg;
  }

  const chutesProvider = buildChutesProviderConfig(env);
  const chutesAgentDefaults = buildChutesAgentDefaults(env) ?? {};

  const providers = {
    ...cfg.models?.providers,
    chutes: chutesProvider.chutes,
  };

  const agentsDefaults = {
    ...cfg.agents?.defaults,
    model: chutesAgentDefaults.model ?? cfg.agents?.defaults?.model,
    models: { ...cfg.agents?.defaults?.models, ...chutesAgentDefaults.models },
  };

  return {
    ...cfg,
    models: { ...cfg.models, providers },
    agents: { ...cfg.agents, defaults: agentsDefaults },
  };
}

/**
 * Apply Chutes provider config for API-key onboarding with a selected model.
 * Use when the user picks a model from the Chutes API during interactive onboarding.
 */
export function applyChutesApiKeyProviderConfig(
  cfg: OpenClawConfig,
  modelEntry: ChutesModelEntry,
): OpenClawConfig {
  const { baseUrl } = resolveChutesEnv();
  const modelDef = buildChutesModelDef({
    id: modelEntry.id,
    name: modelEntry.name ?? modelEntry.id,
    reasoning: modelEntry.reasoning ?? false,
  });
  if (modelEntry.contextWindow != null) {
    modelDef.contextWindow = modelEntry.contextWindow;
  }
  const modelRef = `chutes/${modelEntry.id}`;
  const providers = {
    ...cfg.models?.providers,
    chutes: {
      baseUrl,
      api: "openai-completions" as const,
      auth: "api-key" as const,
      models: [modelDef],
    },
  };
  const models = {
    ...cfg.agents?.defaults?.models,
    [modelRef]: { alias: modelEntry.name ?? modelEntry.id },
  };
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    models: { ...cfg.models, providers },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : {}),
          primary: modelRef,
        },
        models,
      },
    },
  };
}

export { resolveChutesEnv };
