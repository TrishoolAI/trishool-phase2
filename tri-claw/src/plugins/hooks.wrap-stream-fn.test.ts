import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("wrap_stream_fn hook runner", () => {
  it("composes wrapped stream functions sequentially", async () => {
    const baseStreamFn = async function* (
      _model?: unknown,
      _context?: unknown,
      _options?: unknown,
    ) {
      yield "base";
    };

    const registry = createMockPluginRegistry([
      {
        hookName: "wrap_stream_fn",
        handler: ((event: { streamFn: typeof baseStreamFn }) => ({
          streamFn: async function* (_model?: unknown, _context?: unknown, _options?: unknown) {
            yield "first";
            yield* event.streamFn(undefined, undefined, undefined);
          },
        })) as (...args: unknown[]) => unknown,
      },
      {
        hookName: "wrap_stream_fn",
        handler: ((event: { streamFn: typeof baseStreamFn }) => ({
          streamFn: async function* (_model?: unknown, _context?: unknown, _options?: unknown) {
            yield "second";
            yield* event.streamFn(undefined, undefined, undefined);
          },
        })) as (...args: unknown[]) => unknown,
      },
    ]);

    const runner = createHookRunner(registry);
    const wrapped = await runner.runWrapStreamFn(
      {
        streamFn: baseStreamFn as never,
        runId: "run-1",
        provider: "chutes",
        model: "guard",
        modelApi: "openai-completions",
      },
      {
        agentId: "main",
        sessionId: "session-1",
      },
    );

    const values: string[] = [];
    if (wrapped?.streamFn) {
      for await (const item of wrapped.streamFn(
        {} as never,
        {} as never,
        undefined,
      ) as AsyncIterable<string>) {
        values.push(item);
      }
    }

    expect(values).toEqual(["second", "first", "base"]);
  });
});
