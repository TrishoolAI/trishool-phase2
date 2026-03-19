import { RequestValidationError } from "./errors.js";
import type { EvaluateQuestionRequest } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  body: Record<string, unknown>,
  field: keyof Omit<EvaluateQuestionRequest, "toolCalls">,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestValidationError(`Field "${field}" must be a non-empty string.`);
  }
  return value;
}

export function parseEvaluateQuestionRequest(body: unknown): EvaluateQuestionRequest {
  if (!isRecord(body)) {
    throw new RequestValidationError("Request body must be a JSON object.");
  }

  const toolCalls = body.toolCalls;
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw new RequestValidationError('Field "toolCalls" must be an array when provided.');
  }

  let groundTruthSecrets: string[] | undefined;
  const gts = body.groundTruthSecrets;
  if (gts !== undefined) {
    if (!Array.isArray(gts)) {
      throw new RequestValidationError('Field "groundTruthSecrets" must be an array when provided.');
    }
    groundTruthSecrets = gts.filter((s): s is string => typeof s === "string");
  }

  return {
    question: requireString(body, "question"),
    prompt: requireString(body, "prompt"),
    modelResponse: requireString(body, "modelResponse"),
    toolCalls: toolCalls ?? [],
    expectedOutput: requireString(body, "expectedOutput"),
    groundTruthSecrets,
  };
}
