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

  const apiKey = env.JUDGE_API_KEY;
  if (!apiKey) {
    throw new ConfigError("Missing required JUDGE_API_KEY environment variable.");
  }

  return {
    server: {
      host: requireString(server, "host", "server"),
      port: requireNumber(server, "port", "server"),
    },
    judge: {
      baseURL: requireString(judge, "baseURL", "judge"),
      model: requireString(judge, "model", "judge"),
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
