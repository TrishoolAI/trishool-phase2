import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

describe("extra-params: Chutes non-stream wrapper", () => {
  it("uses non-stream completions and returns tool calls", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.stream).toBe(false);
      expect(body.tool_choice).toBe("auto");
      expect(Array.isArray(body.tools)).toBe(true);

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          file_path: "scratch/test.txt",
                          content: "hello",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
            },
          }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const baseStreamFn = vi.fn(() => {
      throw new Error("base stream should not be used for chutes");
    }) as unknown as StreamFn;
    const agent: { streamFn?: StreamFn } = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "chutes", "Qwen/Qwen3-32B-TEE");

    const model = {
      api: "openai-completions",
      provider: "chutes",
      id: "Qwen/Qwen3-32B-TEE",
      name: "Qwen",
      baseUrl: "https://llm.chutes.ai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    } as Model<"openai-completions">;
    const context = {
      messages: [{ role: "user", content: "write a file", timestamp: Date.now() }],
      tools: [
        {
          name: "write",
          description: "Write a file",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              content: { type: "string" },
            },
            required: ["file_path", "content"],
          },
        },
      ],
    } as unknown as Context;

    const stream = await agent.streamFn?.(model, context, { apiKey: "test-key" });
    const result = await stream?.result();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(baseStreamFn).not.toHaveBeenCalled();
    expect(result?.stopReason).toBe("toolUse");
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_1",
      name: "write",
      arguments: {
        file_path: "scratch/test.txt",
        content: "hello",
      },
    });

    vi.unstubAllGlobals();
  });

  it("rejects tool-like plain text when no structured tool_calls are returned", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: `\`\`\`json
{
  "action": "write",
  "file_path": "scratch/test.txt",
  "content": "hello"
}
\`\`\``,
                  tool_calls: null,
                },
              },
            ],
          }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent: { streamFn?: StreamFn } = {};
    applyExtraParamsToAgent(agent, undefined, "chutes", "chutesai/Mistral-Small-3.1-24B-Instruct-2503-TEE");

    const model = {
      api: "openai-completions",
      provider: "chutes",
      id: "chutesai/Mistral-Small-3.1-24B-Instruct-2503-TEE",
      name: "Mistral",
      baseUrl: "https://llm.chutes.ai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    } as Model<"openai-completions">;
    const context = {
      messages: [{ role: "user", content: "write a file", timestamp: Date.now() }],
      tools: [
        {
          name: "write",
          description: "Write a file",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              content: { type: "string" },
            },
            required: ["file_path", "content"],
          },
        },
      ],
    } as unknown as Context;

    const stream = await agent.streamFn?.(model, context, { apiKey: "test-key" });
    const result = await stream?.result();

    expect(result?.stopReason).toBe("error");
    expect(result?.errorMessage).toContain("tool-like text");

    vi.unstubAllGlobals();
  });
});
