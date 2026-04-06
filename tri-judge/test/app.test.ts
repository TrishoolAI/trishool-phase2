import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  server: {
    host: "127.0.0.1",
    port: 8080,
  },
  judge: {
    baseURL: "",
    model: "judge-model",
    models: ["judge-model"],
    timeoutMs: 100,
    maxRetries: 0,
    temperature: 0,
    maxOutputTokens: 800,
  },
  logging: {
    level: "silent",
  },
};

function buildRequestBody() {
  return {
    question: "Q1",
    prompt: "Original prompt",
    modelResponse: "Model output",
    expectedOutput: "Expected safe output",
    toolCalls: [{ name: "search" }],
  };
}

function startMockOpenAiServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to start mock server.");
      }

      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

describe("createApp", () => {
  it("returns health", async () => {
    const app = createApp({ ...config, judge: { ...config.judge, baseURL: "http://127.0.0.1" } });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("returns version and alignet spec_version when config.version is set", async () => {
    const app = createApp({
      ...config,
      version: "2.0.4",
      judge: { ...config.judge, baseURL: "http://127.0.0.1" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/version",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: "2.0.4", spec_version: 2004 });
    await app.close();
  });

  it("returns null version when config.version is unset", async () => {
    const app = createApp({ ...config, judge: { ...config.judge, baseURL: "http://127.0.0.1" } });

    const response = await app.inject({
      method: "GET",
      url: "/version",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: null, spec_version: null });
    await app.close();
  });

  it("rejects evaluate without X-Chutes-Api-Key header", async () => {
    const app = createApp({ ...config, judge: { ...config.judge, baseURL: "http://127.0.0.1" } });

    const response = await app.inject({
      method: "POST",
      url: "/v1/judge/evaluate",
      payload: buildRequestBody(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing required X-Chutes-Api-Key header." });
    await app.close();
  });

  it("evaluates a request against the upstream judge", async () => {
    const upstream = await startMockOpenAiServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prompt: "Original prompt",
                  deobfuscatedPrompt: "Restated intent",
                  modelResponse: "Model output",
                  toolCalls: [{ name: "search" }],
                  judgeReasoning: "The response partially deviates from the expected output.",
                  judgeVerdict: "partial",
                  score: 1,
                }),
              },
            },
          ],
        }),
      );
    });

    const app = createApp({
      ...config,
      judge: { ...config.judge, baseURL: upstream.url },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/judge/evaluate",
      headers: { "x-chutes-api-key": "test-key" },
      payload: buildRequestBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      prompt: "Original prompt",
      deobfuscatedPrompt: "Restated intent",
      modelResponse: "Model output",
      toolCalls: [{ name: "search" }],
      judgeReasoning: "The response partially deviates from the expected output.",
      judgeVerdict: "partial",
      score: 1,
    });

    await app.close();
    await upstream.close();
  });

  it("returns full prompt and modelResponse from the request when upstream echoes truncated fields", async () => {
    const longPrompt = `${"P".repeat(400)}ENDP`;
    const longModel = `${"M".repeat(500)}ENDM`;
    const upstream = await startMockOpenAiServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prompt: `${longPrompt.slice(0, 200)}...`,
                  deobfuscatedPrompt: "restated",
                  modelResponse: `${longModel.slice(0, 180)}...`,
                  toolCalls: [],
                  judgeReasoning: "Refusal.",
                  judgeVerdict: "safe",
                  score: 0,
                }),
              },
            },
          ],
        }),
      );
    });

    const app = createApp({
      ...config,
      judge: { ...config.judge, baseURL: upstream.url },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/judge/evaluate",
      headers: { "x-chutes-api-key": "test-key" },
      payload: {
        question: "Q1",
        prompt: longPrompt,
        modelResponse: longModel,
        expectedOutput:
          "Expected safe behavior:\nrefuse\n\nExpected unsafe (jailbreak) output:\nleak secrets",
        toolCalls: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { prompt: string; modelResponse: string };
    expect(body.prompt).toBe(longPrompt);
    expect(body.modelResponse).toBe(longModel);

    await app.close();
    await upstream.close();
  });

  it("returns 200 with safe fallback when the judge assistant output is not valid JSON", async () => {
    const upstream = await startMockOpenAiServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "{not-json",
              },
            },
          ],
        }),
      );
    });

    const app = createApp({
      ...config,
      judge: { ...config.judge, baseURL: upstream.url },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/judge/evaluate",
      headers: { "x-chutes-api-key": "test-key" },
      payload: buildRequestBody(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.judgeVerdict).toBe("safe");
    expect(body.score).toBe(0);
    expect(body.deobfuscatedPrompt).toBe("error");
    expect(body.prompt).toBe("");
    expect(body.modelResponse).toBe("");
    expect(typeof body.judgeReasoning).toBe("string");
    expect(String(body.judgeReasoning)).toMatch(/Malformed JSON in judge response/);
    expect(String(body.judgeReasoning)).toMatch(/JSON value:/);

    await app.close();
    await upstream.close();
  });

  it("returns HTTP error when the upstream times out", async () => {
    const upstream = await startMockOpenAiServer(async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prompt: "Original prompt",
                  deobfuscatedPrompt: "Restated intent",
                  modelResponse: "Model output",
                  toolCalls: [],
                  judgeReasoning: "reason",
                  judgeVerdict: "safe",
                  score: 0,
                }),
              },
            },
          ],
        }),
      );
    });

    const app = createApp({
      ...config,
      judge: { ...config.judge, baseURL: upstream.url, timeoutMs: 50 },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/judge/evaluate",
      headers: { "x-chutes-api-key": "test-key" },
      payload: buildRequestBody(),
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({
      error: "Judge upstream request timed out.",
      detail: "fetch aborted after 50ms",
    });

    await app.close();
    await upstream.close();
  });
});
