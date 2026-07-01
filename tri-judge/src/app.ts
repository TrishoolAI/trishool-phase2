import Fastify, { type FastifyInstance } from "fastify";
import { JudgeUpstreamError, RequestValidationError } from "./errors.js";
import { parseEvaluateQuestionRequest } from "./request.js";
import type { AppConfig } from "./types.js";
import { semverToAlignetSpecVersion } from "./alignet-spec-version.js";
import { JudgeClient } from "./judge-client.js";

const MISSING_UPSTREAM_API_KEY =
  "Missing upstream API key. Send Authorization: Bearer <token>, X-OpenRouter-Api-Key, or X-Chutes-Api-Key.";


/** Per-request secret forwarded to the LLM as `Authorization: Bearer` (Chutes + OpenRouter compatible). */
function resolveUpstreamApiKeyFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const authorization = headers.authorization;
  const authLine = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authLine === "string") {
    const m = authLine.match(/^\s*Bearer\s+(\S+)/i);
    const token = m?.[1]?.trim();
    if (token) {
      return token;
    }
  }
  const openrouter = headers["x-openrouter-api-key"];
  const orLine = Array.isArray(openrouter) ? openrouter[0] : openrouter;
  if (typeof orLine === "string" && orLine.trim()) {
    return orLine.trim();
  }
  const chutes = headers["x-chutes-api-key"];
  const chutesLine = Array.isArray(chutes) ? chutes[0] : chutes;
  if (typeof chutesLine === "string" && chutesLine.trim()) {
    return chutesLine.trim();
  }
  return undefined;
}

export function createApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logging?.level ?? "info",
    },
  });

  const judgeClient = new JudgeClient(config);

  app.get("/health", async () => ({
    status: "ok",
  }));

  app.get("/version", async () => {
    const v = config.version?.trim();
    if (!v) {
      return { version: null, spec_version: null };
    }
    return { version: v, spec_version: semverToAlignetSpecVersion(v) };
  });

  app.post("/v1/judge/evaluate", async (request, reply) => {
    try {
      const apiKey = resolveUpstreamApiKeyFromHeaders(request.headers);
      if (!apiKey) {
        return reply.code(401).send({
          error: MISSING_UPSTREAM_API_KEY,
        });
      }

      const parsedRequest = parseEvaluateQuestionRequest(request.body);

      // hotfix/0008: strip groundTruthSecrets before the LLM call — defense in
      // depth against judge poisoning. Q7–Q12 are now non-PII rubric questions;
      // if PII secrets somehow arrived here they would override the rubric and
      // pass full jailbreaks as safe (score 0). Validator already sends no
      // secrets (hardcoded _eval_ground_truth_questions={}) and tri-check
      // default-denies the overlay, so this is belt-and-suspenders only.
      //
      // To restore: remove the override line below when questions.json Q7–Q12
      // rubric realigns with PII fixtures and the upstream callers are confirmed
      // to send the correct per-session secrets again.
      const judgeRequest = { ...parsedRequest, groundTruthSecrets: undefined };
      // const judgeRequest = parsedRequest; // ← restore this (and delete the line above) to re-enable groundTruthSecrets

      const result = await judgeClient.evaluate(judgeRequest, apiKey);
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return reply.code(400).send({
          error: error.message,
        });
      }
      if (error instanceof JudgeUpstreamError) {
        request.log.error({ err: error }, "Judge upstream request failed");
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
        });
      }

      request.log.error({ err: error }, "Unexpected error while evaluating question");
      return reply.code(500).send({
        error: "Internal server error.",
      });
    }
  });

  return app;
}
