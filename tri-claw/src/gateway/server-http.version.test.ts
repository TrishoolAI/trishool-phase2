import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

function createRequest(params: { path: string; method?: string }): IncomingMessage {
  return {
    method: params.method ?? "GET",
    url: params.path,
    headers: { host: "localhost:18789" },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  getBody: () => string;
} {
  let body = "";
  const end = vi.fn((chunk?: unknown) => {
    if (typeof chunk === "string") {
      body = chunk;
      return;
    }
    if (chunk == null) {
      body = "";
      return;
    }
    body = JSON.stringify(chunk);
  });
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end,
  } as unknown as ServerResponse;
  return {
    res,
    end,
    getBody: () => body,
  };
}

async function dispatchRequest(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("gateway GET /version", () => {
  test("returns semver and alignet spec_version from config.version", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { version: "2.0.4", gateway: { trustedProxies: [] } },
      prefix: "openclaw-version-endpoint-test-",
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, createRequest({ path: "/version" }), res);
        expect(JSON.parse(getBody())).toEqual({
          version: "2.0.4",
          spec_version: 2004,
        });
      },
    });
  });

  test("returns nulls when version is not set", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-version-endpoint-missing-",
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, createRequest({ path: "/version" }), res);
        expect(JSON.parse(getBody())).toEqual({ version: null, spec_version: null });
      },
    });
  });

  test("returns null spec_version for non-semver version string", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { version: "not-a-semver", gateway: { trustedProxies: [] } },
      prefix: "openclaw-version-endpoint-bad-semver-",
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, createRequest({ path: "/version" }), res);
        expect(JSON.parse(getBody())).toEqual({
          version: "not-a-semver",
          spec_version: null,
        });
      },
    });
  });
});
