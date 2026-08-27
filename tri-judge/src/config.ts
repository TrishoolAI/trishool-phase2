import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "./errors.js";
import type { AppConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = "docker/judge.lean.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  ctx: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`Missing or invalid ${ctx}.${field}.`);
  }
  return value;
}

function requireNumber(
  record: Record<string, unknown>,
  field: string,
  ctx: string,
): number {
  const value = record[field];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`Missing or invalid ${ctx}.${field}.`);
  }
  return value;
}

function parseModelChain(record: Record<string, unknown>, ctx: string): string[] {
  const modelsRaw = record.models;
  if (Array.isArray(modelsRaw)) {
    const models = modelsRaw
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (models.length === 0) {
      throw new ConfigError(`Missing or invalid ${ctx}.models.`);
    }
    return models;
  }

  const model = requireString(record, "model", ctx);
  return [model];
}

function optionalRecord(record: Record<string, unknown>, field: string, ctx: string): Record<string, unknown> | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ConfigError(`Missing or invalid ${ctx}.${field}.`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, field: string, ctx: string): boolean | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`Missing or invalid ${ctx}.${field}.`);
  }
  return value;
}

/** Legacy flat `judge.baseURL` / `judge.models`, or `judge.provider` + `judge.providers.<id>`. */
function resolveJudgeUpstream(judge: Record<string, unknown>): {
  baseURL: string;
  modelChain: string[];
  chatTemplateKwargs?: Record<string, unknown>;
  enableThinking?: boolean;
} {
  const providersRaw = judge.providers;
  if (providersRaw === undefined) {
    return {
      baseURL: requireString(judge, "baseURL", "judge"),
      modelChain: parseModelChain(judge, "judge"),
      chatTemplateKwargs: optionalRecord(judge, "chatTemplateKwargs", "judge"),
      enableThinking: optionalBoolean(judge, "enableThinking", "judge"),
    };
  }
  if (!isRecord(providersRaw)) {
    throw new ConfigError("Missing or invalid judge.providers.");
  }

  const providerId = requireString(judge, "provider", "judge");
  const branch = providersRaw[providerId];
  if (!isRecord(branch)) {
    throw new ConfigError(`Missing or invalid judge.providers.${providerId}.`);
  }
  const ctx = `judge.providers.${providerId}`;
  return {
    baseURL: requireString(branch, "baseURL", ctx),
    modelChain: parseModelChain(branch, ctx),
    chatTemplateKwargs:
      optionalRecord(branch, "chatTemplateKwargs", ctx) ??
      optionalRecord(judge, "chatTemplateKwargs", "judge"),
    enableThinking:
      optionalBoolean(branch, "enableThinking", ctx) ??
      optionalBoolean(judge, "enableThinking", "judge"),
  };
}

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  return resolve(env.JUDGE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configPath = resolveConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Failed to read config file at ${configPath}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config file at ${configPath} is not valid JSON.`);
  }

  if (!isRecord(parsed)) {
    throw new ConfigError("Config root must be an object.");
  }

  const server = parsed.server;
  const judge = parsed.judge;

  if (!isRecord(server)) {
    throw new ConfigError("Missing or invalid server config.");
  }

  if (!isRecord(judge)) {
    throw new ConfigError("Missing or invalid judge config.");
  }

  const upstream = resolveJudgeUpstream(judge);
  const modelChain = upstream.modelChain;

  const rootVersion =
    typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : undefined;

  return {
    version: rootVersion,
    server: {
      host: requireString(server, "host", "server"),
      port: requireNumber(server, "port", "server"),
    },
    judge: {
      baseURL: upstream.baseURL,
      models: modelChain,
      model: modelChain[0],
      chatTemplateKwargs: upstream.chatTemplateKwargs,
      enableThinking: upstream.enableThinking,
      timeoutMs: requireNumber(judge, "timeoutMs", "judge"),
      maxRetries: requireNumber(judge, "maxRetries", "judge"),
      temperature:
        typeof judge.temperature === "number" ? judge.temperature : undefined,
      maxOutputTokens:
        typeof judge.maxOutputTokens === "number"
          ? judge.maxOutputTokens
          : undefined,
    },
    logging: isRecord(parsed.logging)
      ? {
          level:
            typeof parsed.logging.level === "string"
              ? parsed.logging.level
              : undefined,
        }
      : undefined,
  };
}
