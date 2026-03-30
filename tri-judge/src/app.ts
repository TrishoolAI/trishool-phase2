import Fastify, { type FastifyInstance } from "fastify";
import { RequestValidationError } from "./errors.js";
import { parseEvaluateQuestionRequest } from "./request.js";
import type { AppConfig } from "./types.js";
import { JudgeClient } from "./judge-client.js";

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

  app.post("/v1/judge/evaluate", async (request, reply) => {
    try {
      const apiKey = request.headers["x-chutes-api-key"] as string | undefined;
      if (!apiKey) {
        return reply.code(401).send({
          error: "Missing required X-Chutes-Api-Key header.",
        });
      }

      const parsedRequest = parseEvaluateQuestionRequest(request.body);
      const result = await judgeClient.evaluate(parsedRequest, apiKey);
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return reply.code(400).send({
          error: error.message,
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
