import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import register, { __testing } from "./index.js";

describe("guard-model helpers", () => {
  it("prefers per-phase overrides over top-level defaults", () => {
    expect(
      __testing.resolveScopeConfig(
        {
          enabled: true,
          model: "chutes/base",
          authProfileId: "base",
          input: { enabled: true, model: "chutes/input", authProfileId: "input" },
        },
        "input",
      ),
    ).toEqual({
      enabled: true,
      model: "chutes/input",
      authProfileId: "input",
      payloadMode: "full_context",
      queryMode: undefined,
    });
  });

  it("builds a stable block message", () => {
    expect(__testing.buildBlockErrorMessage({}, "reason here")).toContain(
      "probable prompt injection detected.",
    );
    expect(__testing.buildBlockErrorMessage({ refusalText: "Guard blocked." }, "reason here")).toBe(
      "Guard blocked. reason here",
    );
  });

  it("truncates oversized guard payloads", () => {
    const value = "x".repeat(20);
    const truncated = __testing.truncateForGuard(value, 8);
    expect(truncated).toContain("[truncated 12 chars]");
  });

  it("parses JSON decisions even when the guard model adds prose", () => {
    expect(
      __testing.parseGuardDecisionText(
        'Safety: Content looks fine.\n{"decision":"allow","reason":"benign greeting"}',
      ),
    ).toEqual({
      decision: "allow",
      reason: "benign greeting",
    });
  });

  it("parses Qwen guard safety labels", () => {
    expect(__testing.parseGuardDecisionText("Safety: Unsafe\nCategories: Violent")).toEqual({
      decision: "block",
      reason: "violent",
    });
    expect(__testing.parseGuardDecisionText("Safety: Safe\nCategories: None")).toEqual({
      decision: "allow",
      reason: "none",
    });
    expect(
      __testing.parseGuardDecisionText(
        "Safety: Controversial\nCategories: Politically Sensitive Topics",
      ),
    ).toEqual({
      decision: "allow",
      reason: "politically sensitive topics",
    });
  });

  it("uses official Qwen block categories by default", () => {
    expect(__testing.parseGuardDecisionText("Safety: Unsafe\nCategories: Jailbreak")).toEqual({
      decision: "block",
      reason: "jailbreak",
    });
    expect(__testing.parseGuardDecisionText("Safety: Unsafe\nCategories: PII")).toEqual({
      decision: "block",
      reason: "pii",
    });
  });

  it("can build input payloads from only the latest user message", () => {
    expect(
      __testing.buildInputGuardPayload(
        {
          systemPrompt: "system",
          messages: [
            { role: "user", content: "old" },
            { role: "assistant", content: "reply" },
            { role: "user", content: "latest" },
          ],
        },
        "latest_user_message",
      ),
    ).toEqual({
      systemPrompt: "system",
      latestUserMessage: { role: "user", content: "latest" },
    });
  });

  it("parses Chutes /v1/classify (Halo) JSON by status", () => {
    expect(
      __testing.parseChutesClassifyResponse({
        status: "HARMFUL",
        safety_label: "Unsafe",
        category: "credential_or_secret_access",
        attack_overlay: "jailbreak",
      }),
    ).toEqual({
      decision: "block",
      reason: "credential_or_secret_access; jailbreak",
    });
    expect(
      __testing.parseChutesClassifyResponse({
        status: "HARMLESS",
        safety_label: "Safe",
        category: "none",
        attack_overlay: "none",
      }),
    ).toEqual({
      decision: "allow",
      reason: "none",
    });
  });

  it("guardPhaseShouldRun uses classify URL when transport is chutes_classify", () => {
    const classifyCfg = {
      enabled: true,
      transport: "chutes_classify" as const,
      classifyUrl: "https://example.com/v1/classify",
      classifyModel: "halo-guard",
      input: { enabled: true },
      output: { enabled: false },
    };
    expect(__testing.guardPhaseShouldRun(classifyCfg, "input")).toBe(true);
    expect(__testing.guardPhaseShouldRun(classifyCfg, "output")).toBe(false);
    expect(__testing.isChutesClassifyConfigured(classifyCfg)).toBe(true);
    expect(
      __testing.guardPhaseShouldRun(
        { enabled: true, transport: "chutes_classify", input: { enabled: true } },
        "input",
      ),
    ).toBe(false);
  });

  it("buildClassifyQueryString text_extract uses assistantText for output", () => {
    expect(
      __testing.buildClassifyQueryString({
        phase: "output",
        payload: { assistantText: "hello world" },
        queryMode: "text_extract",
        maxChars: 1000,
      }),
    ).toBe("hello world");
  });

  it("buildClassifyQueryString text_extract uses latest user text for input", () => {
    expect(
      __testing.buildClassifyQueryString({
        phase: "input",
        payload: {
          latestUserMessage: {
            role: "user",
            content: [{ type: "text", text: "what is 2+2" }],
          },
        },
        queryMode: "text_extract",
        maxChars: 1000,
      }),
    ).toBe("what is 2+2");
  });

  it("resolveChutesApiKeyForGuard prefers config apiKey over env", async () => {
    const configWithKey = {
      models: { providers: { chutes: { apiKey: "cfg-key-123" } } },
    } as any;
    await expect(__testing.resolveChutesApiKeyForGuard(configWithKey)).resolves.toBe("cfg-key-123");
    await expect(__testing.resolveChutesApiKeyForGuard(undefined)).rejects.toThrow(
      /no Chutes API key available/,
    );
  });

  it("accepts evaluationFailureAction error for strict guard failures", () => {
    const policy = __testing.normalizeGuardPolicyConfig({
      evaluationFailureAction: "error",
    });
    expect(policy.evaluationFailureAction).toBe("error");
  });

  it("isGuardConnectivityFailure detects DNS/refused/timeout and fetch TypeError", () => {
    expect(__testing.isGuardConnectivityFailure(Object.assign(new Error("e"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(__testing.isGuardConnectivityFailure(Object.assign(new Error("e"), { code: "ENOTFOUND" }))).toBe(true);
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(__testing.isGuardConnectivityFailure(aborted)).toBe(true);
    expect(__testing.isGuardConnectivityFailure(new TypeError("fetch failed"))).toBe(true);
    expect(__testing.isGuardConnectivityFailure(new Error("classify HTTP 401: nope"))).toBe(false);
    expect(
      __testing.isGuardConnectivityFailure(
        Object.assign(new Error("wrap"), { cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }) }),
      ),
    ).toBe(true);
    expect(
      __testing.isGuardConnectivityFailure(
        new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]),
      ),
    ).toBe(true);
  });

  it("lets policy override safety-label defaults", () => {
    const policy = __testing.normalizeGuardPolicyConfig({
      allowLabels: ["safe"],
      blockLabels: ["unsafe", "controversial"],
      allowReasons: ["none"],
      blockReasons: ["jailbreak"],
      unknownSafetyLabelAction: "allow",
      evaluationFailureAction: "allow",
      parseMode: "json_or_safety_label",
    });

    expect(
      __testing.parseGuardDecisionText(
        "Safety: Controversial\nCategories: Politically Sensitive Topics",
        policy,
      ),
    ).toEqual({
      decision: "block",
      reason: "politically sensitive topics",
    });
  });

  it("awaits promised streams before yielding events", async () => {
    const hooks: Record<string, Function> = {};
    const pluginConfig = {
      enabled: true,
      output: { enabled: false },
    };
    const api = {
      id: "guard-model",
      name: "Guard Model",
      source: "bundled",
      config: {},
      pluginConfig,
      runtime: {
        config: {
          loadConfigFresh: () => ({
            plugins: {
              entries: {
                "guard-model": { config: pluginConfig },
              },
            },
          }),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      on: vi.fn((hookName: string, handler: Function) => {
        hooks[hookName] = handler;
      }),
    };

    register(api as any);

    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "ok" }],
      api: "openai-completions",
      provider: "chutes",
      model: "main",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    const streamFn = vi.fn(async () => {
      const inner = createAssistantMessageEventStream();
      queueMicrotask(() => {
        inner.push({
          type: "done",
          reason: "stop",
          message: assistantMessage,
        });
        inner.end();
      });
      return inner;
    });
    const wrapped = hooks.wrap_stream_fn(
      {
        streamFn,
        runId: "run-1",
        provider: "chutes",
        model: "main",
        modelApi: "openai-completions",
      },
      { sessionId: "session-1", agentId: "main" },
    ) as {
      streamFn: (
        model?: unknown,
        context?: unknown,
        options?: unknown,
      ) =>
        | (AsyncIterable<unknown> & { result: () => Promise<unknown> })
        | Promise<AsyncIterable<unknown> & { result: () => Promise<unknown> }>;
    };

    const events: unknown[] = [];
    const wrappedStream = await wrapped.streamFn(
      { provider: "chutes", id: "main", api: "openai-completions" } as never,
      { messages: [] } as never,
      undefined,
    );
    for await (const item of wrappedStream) {
      events.push(item);
    }
    await expect(wrappedStream.result()).resolves.toEqual(assistantMessage);

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "done",
      reason: "stop",
      message: assistantMessage,
    });
  });
});
