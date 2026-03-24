import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./http-utils.js";

describe("resolveSessionKey forceEphemeral", () => {
  it("ignores explicit session header and user when forceEphemeral", () => {
    const req = {
      headers: {
        "x-openclaw-session-key": "agent:main:openai:pinned",
      },
    } as import("node:http").IncomingMessage;

    const key = resolveSessionKey({
      req,
      agentId: "main",
      user: "alice",
      prefix: "openai",
      forceEphemeral: true,
    });

    expect(key).toMatch(/^agent:main:openai:/);
    expect(key).not.toContain("pinned");
    expect(key).not.toContain("alice");
  });
});
