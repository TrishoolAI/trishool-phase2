import { describe, expect, it, vi } from "vitest";
import { JudgeUpstreamError } from "../src/errors.js";
import { JudgeClient } from "../src/judge-client.js";
import type { AppConfig, EvaluateQuestionRequest } from "../src/types.js";

function makeConfig(models: string[], maxRetries = 0): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 8080,
    },
    judge: {
      baseURL: "https://llm.chutes.ai/v1",
      model: models[0] ?? "model-primary",
      models,
      timeoutMs: 10_000,
      maxRetries,
      temperature: 0,
      maxOutputTokens: 512,
    },
    logging: {
      level: "silent",
    },
  };
}

function makeInput(): EvaluateQuestionRequest {
  return {
    question: "Q1",
    prompt: "prompt",
    modelResponse: "response",
    toolCalls: [],
    expectedOutput: "expected",
  };
}

function judgeResultObject() {
  return {
    prompt: "prompt",
    deobfuscatedPrompt: "deobfuscated",
    modelResponse: "response",
    toolCalls: [],
    judgeReasoning: "reason",
    judgeVerdict: "safe",
    score: 0,
  };
}

function makeJudgePayload() {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify(judgeResultObject()),
        },
      },
    ],
  });
}

/** Some Chutes / OpenAI-compatible stacks return `{ text }` without `type: "text"`. */
function makeJudgePayloadArrayPartNoType() {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: [{ text: JSON.stringify(judgeResultObject()) }],
        },
      },
    ],
  });
}

/** Reasoning-style APIs sometimes leave `content` empty and use `reasoning_content`. */
function makeJudgePayloadReasoningContent() {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: "",
          reasoning_content: JSON.stringify(judgeResultObject()),
        },
      },
    ],
  });
}

function parseModelFromRequest(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
  return body.model ?? "";
}

describe("JudgeClient assistant text extraction", () => {
  it("accepts array content with text but no type field", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(makeJudgePayloadArrayPartNoType(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new JudgeClient(makeConfig(["solo"]), fetchImpl as unknown as typeof fetch);
    const result = await client.evaluate(makeInput(), "api-key");
    expect(result.judgeVerdict).toBe("safe");
  });

  it("falls back to reasoning_content when content is empty", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(makeJudgePayloadReasoningContent(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new JudgeClient(makeConfig(["solo"]), fetchImpl as unknown as typeof fetch);
    const result = await client.evaluate(makeInput(), "api-key");
    expect(result.judgeVerdict).toBe("safe");
  });
});

describe("JudgeClient model fallback", () => {
  it("tries models in order and falls back on 429", async () => {
    const seenModels: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = parseModelFromRequest(init);
      seenModels.push(model);
      if (model === "model-primary") {
        return new Response('{"error":"rate limit"}', { status: 429 });
      }
      return new Response(makeJudgePayload(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new JudgeClient(
      makeConfig(["model-primary", "model-secondary", "model-tertiary"]),
      fetchImpl as unknown as typeof fetch,
    );
    const result = await client.evaluate(makeInput(), "api-key");

    expect(result.judgeVerdict).toBe("safe");
    expect(seenModels).toEqual(["model-primary", "model-secondary"]);
  });

  it("falls back on selected statuses and not on 402", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = parseModelFromRequest(init);
      if (model === "model-primary") {
        return new Response('{"error":"payment required"}', { status: 402 });
      }
      return new Response(makeJudgePayload(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new JudgeClient(
      makeConfig(["model-primary", "model-secondary"]),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(client.evaluate(makeInput(), "api-key")).rejects.toMatchObject({
      statusCode: 402,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not fallback on 500", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = parseModelFromRequest(init);
      if (model === "model-primary") {
        return new Response('{"error":"internal"}', { status: 500 });
      }
      return new Response(makeJudgePayload(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new JudgeClient(
      makeConfig(["model-primary", "model-secondary"]),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(client.evaluate(makeInput(), "api-key")).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-last model when maxRetries > 0 (single attempt then fallback)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = parseModelFromRequest(init);
      if (model === "model-primary") {
        return new Response('{"error":"rate limit"}', { status: 429 });
      }
      return new Response(makeJudgePayload(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new JudgeClient(
      makeConfig(["model-primary", "model-secondary"], 2),
      fetchImpl as unknown as typeof fetch,
    );
    const result = await client.evaluate(makeInput(), "api-key");
    expect(result.judgeVerdict).toBe("safe");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries only the last model maxRetries+1 times on repeated 429", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"rate limit"}', { status: 429 }));

    const client = new JudgeClient(
      makeConfig(["solo"], 2),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(client.evaluate(makeInput(), "api-key")).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns last fallback-eligible upstream error when all models fail", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = parseModelFromRequest(init);
      if (model === "model-primary") {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      if (model === "model-secondary") {
        return new Response('{"error":"unavailable"}', { status: 503 });
      }
      return new Response('{"error":"internal"}', { status: 500 });
    });

    const client = new JudgeClient(
      makeConfig(["model-primary", "model-secondary", "model-tertiary"]),
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.evaluate(makeInput(), "api-key").catch((error) => error);
    expect(result).toBeInstanceOf(JudgeUpstreamError);
    expect(result).toMatchObject({ statusCode: 500 });
  });
});
