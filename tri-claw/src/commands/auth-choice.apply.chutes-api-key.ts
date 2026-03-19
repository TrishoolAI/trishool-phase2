import { applyChutesApiKeyProviderConfig, fetchChutesModels } from "../config/chutes.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";
import { applyAuthProfileConfig, setChutesApiKey } from "./onboard-auth.js";

const CHUTES_DEFAULT_MODEL_REF = "chutes/zai-org/GLM-4.7-TEE";

export async function applyAuthChoiceChutesApiKey(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "chutes-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);

  const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.token,
    tokenProvider: params.opts?.tokenProvider,
    expectedProviders: ["chutes"],
    provider: "chutes",
    envLabel: "Chutes API key",
    promptMessage: "Enter Chutes API key (CHUTES_API_KEY)",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (key) => setChutesApiKey(key, params.agentDir),
    noteMessage: [
      "Chutes provides access to models at https://llm.chutes.ai.",
      "Set CHUTES_API_KEY in .env, or paste your API key.",
    ].join("\n"),
    noteTitle: "Chutes API key",
  });

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "chutes:default",
    provider: "chutes",
    mode: "api_key",
  });

  const spin = params.prompter.progress("Fetching models from Chutes API…");
  const models = await fetchChutesModels(undefined, apiKey);
  spin.stop(models.length > 0 ? "Models loaded" : "No models found");

  const modelRefPrefix = "chutes/";
  const options: { value: string; label: string; hint?: string }[] = models.map((m) => ({
    value: `${modelRefPrefix}${m.id}`,
    label: m.id,
    hint:
      m.contextWindow || m.reasoning
        ? [m.contextWindow ? `context: ${m.contextWindow}` : null, m.reasoning ? "reasoning" : null]
            .filter(Boolean)
            .join(", ")
        : undefined,
  }));

  const defaultRef = CHUTES_DEFAULT_MODEL_REF;
  options.sort((a, b) => {
    if (a.value === defaultRef) {
      return -1;
    }
    if (b.value === defaultRef) {
      return 1;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });

  const selectedModelRef =
    options.length === 0
      ? defaultRef
      : options.length === 1
        ? options[0].value
        : await params.prompter.select({
            message: "Select Chutes model",
            options,
            initialValue: options.some((o) => o.value === defaultRef)
              ? defaultRef
              : options[0].value,
          });

  const selectedModelId = selectedModelRef.replace(/^chutes\//, "");
  const selectedEntry = models.find((m) => m.id === selectedModelId) ?? {
    id: selectedModelId,
    name: selectedModelId,
    provider: "chutes",
  };

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: selectedModelRef,
    applyDefaultConfig: (config) => {
      const withProvider = applyChutesApiKeyProviderConfig(config, selectedEntry);
      return ensureModelAllowlistEntry({
        cfg: withProvider,
        modelRef: selectedModelRef,
      });
    },
    applyProviderConfig: (config) => applyChutesApiKeyProviderConfig(config, selectedEntry),
    noteDefault: selectedModelRef,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
