import { describe, expect, it } from "vitest";
import { resolveGatewayChatCompletionsStateless } from "./chat-completions-stateless.js";

describe("resolveGatewayChatCompletionsStateless", () => {
  it("returns all false when unset", () => {
    expect(resolveGatewayChatCompletionsStateless(undefined)).toEqual({
      enabled: false,
      ephemeralSession: false,
      denyWorkspaceWrites: false,
      skipSessionPersistence: false,
    });
  });

  it("enables full stateless defaults for true", () => {
    expect(
      resolveGatewayChatCompletionsStateless({
        gateway: {
          http: { endpoints: { chatCompletions: { stateless: true } } },
        },
      } as never),
    ).toEqual({
      enabled: true,
      ephemeralSession: true,
      denyWorkspaceWrites: true,
      skipSessionPersistence: true,
    });
  });

  it("respects object overrides", () => {
    expect(
      resolveGatewayChatCompletionsStateless({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                stateless: {
                  ephemeralSession: true,
                  denyWorkspaceWrites: false,
                  skipSessionPersistence: false,
                },
              },
            },
          },
        },
      } as never),
    ).toEqual({
      enabled: true,
      ephemeralSession: true,
      denyWorkspaceWrites: false,
      skipSessionPersistence: false,
    });
  });

  it("disables for enabled: false object", () => {
    expect(
      resolveGatewayChatCompletionsStateless({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: { stateless: { enabled: false, ephemeralSession: true } },
            },
          },
        },
      } as never),
    ).toEqual({
      enabled: false,
      ephemeralSession: false,
      denyWorkspaceWrites: false,
      skipSessionPersistence: false,
    });
  });
});
