import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  formatRawAssistantErrorForUi,
  isLikelyHttpErrorText,
} from "../agents/pi-embedded-helpers/errors.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";
import type { ResolvedGatewayChatCompletionsStateless } from "./chat-completions-stateless.js";
import { collectGuardRefusalPrefixes, isGuardPolicyRefusalText } from "./openai-http-guard-refusal.js";
import type { GuardClassifyHttpOverrides } from "../plugins/types.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  chatCompletionsStateless?: ResolvedGatewayChatCompletionsStateless;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
  /** Per-request Chutes API key (ephemeral auth; not loaded from .env). */
  chutes_api_key?: unknown;
  /** Per-request provider API keys: { chutes?: string, ... }. */
  provider_api_keys?: unknown;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function resolveGuardClassifyOverridesFromRequest(req: IncomingMessage): GuardClassifyHttpOverrides | undefined {
  const rawLocal = req.headers["x-openclaw-guard-classify-local"];
  const localVal = Array.isArray(rawLocal) ? rawLocal[0] : rawLocal;
  const skipClassifyAuth = typeof localVal === "string" && localVal.trim() === "1";

  const rawUrl = req.headers["x-openclaw-guard-classify-url"];
  const classifyUrl = (typeof rawUrl === "string" ? rawUrl : rawUrl?.[0])?.trim();

  const rawModel = req.headers["x-openclaw-guard-classify-model"];
  const classifyModel = (typeof rawModel === "string" ? rawModel : rawModel?.[0])?.trim();

  if (!skipClassifyAuth && !classifyUrl && !classifyModel) {
    return undefined;
  }
  return {
    skipClassifyAuth: skipClassifyAuth || undefined,
    classifyUrl: classifyUrl || undefined,
    classifyModel: classifyModel || undefined,
  };
}

function resolveChutesApiKeyFromRequest(params: {
  headers: IncomingMessage["headers"];
  body: OpenAiChatCompletionRequest;
}): string | undefined {
  const headerKey = params.headers["x-chutes-api-key"];
  const fromHeader =
    typeof headerKey === "string" ? headerKey.trim() : Array.isArray(headerKey) ? headerKey[0]?.trim() : undefined;
  if (fromHeader) return fromHeader;
  const fromBody = params.body.chutes_api_key;
  const bodyStr =
    typeof fromBody === "string" ? fromBody.trim() : fromBody != null ? String(fromBody).trim() : undefined;
  if (bodyStr) return bodyStr;
  const providerKeys = params.body.provider_api_keys;
  if (providerKeys && typeof providerKeys === "object" && !Array.isArray(providerKeys)) {
    const chutes = (providerKeys as Record<string, unknown>).chutes;
    const chutesStr =
      typeof chutes === "string" ? chutes.trim() : chutes != null ? String(chutes).trim() : undefined;
    if (chutesStr) return chutesStr;
  }
  return undefined;
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string };
  sessionKey: string;
  runId: string;
  providerApiKeyOverrides?: Record<string, string>;
  statelessHttp?: {
    skipSessionPersistence: boolean;
    mergeStatelessHttpDefaults: boolean;
    protectWorkspaceStateFiles?: boolean;
  };
  guardClassifyOverrides?: GuardClassifyHttpOverrides;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: "webchat" as const,
    bestEffortDeliver: false as const,
    ...(params.providerApiKeyOverrides &&
      Object.keys(params.providerApiKeyOverrides).length > 0 && {
        providerApiKeyOverrides: params.providerApiKeyOverrides,
      }),
    ...(params.statelessHttp && { statelessHttp: params.statelessHttp }),
    ...(params.guardClassifyOverrides &&
      (params.guardClassifyOverrides.classifyUrl ||
        params.guardClassifyOverrides.classifyModel ||
        params.guardClassifyOverrides.skipClassifyAuth) && {
        guardClassifyOverrides: params.guardClassifyOverrides,
      }),
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function buildAgentPrompt(messagesUnknown: unknown): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    if (!role || !content) {
      continue;
    }
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: content },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  stateless?: ResolvedGatewayChatCompletionsStateless;
}): string {
  const forceEphemeral = Boolean(
    params.stateless?.enabled && params.stateless.ephemeralSession,
  );
  return resolveSessionKey({
    req: params.req,
    agentId: params.agentId,
    user: params.user,
    prefix: "openai",
    forceEphemeral,
  });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const typed = result as {
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { error?: { message?: string } };
  } | null;
  const metaErr = typed?.meta?.error?.message?.trim();
  if (metaErr) {
    throw new Error(metaErr);
  }
  const payloads = typed?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const errorParts = payloads.filter((p) => p.isError === true);
  if (errorParts.length > 0) {
    const refusalPrefixes = collectGuardRefusalPrefixes(loadConfig());
    const operationalErrors = errorParts.filter((p) => {
      const t = typeof p.text === "string" ? p.text : "";
      return !isGuardPolicyRefusalText(t, refusalPrefixes);
    });
    if (operationalErrors.length > 0) {
      const msg = operationalErrors
        .map((p) => (typeof p.text === "string" ? p.text.trim() : ""))
        .filter(Boolean)
        .join("\n\n");
      throw new Error(msg || "OpenClaw returned an error payload without a message.");
    }
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const raw = content || "No response from OpenClaw.";
  if (isLikelyHttpErrorText(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }
  return raw;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const agentId = resolveAgentIdForRequest({ req, model });
  const st = opts.chatCompletionsStateless;
  const sessionKey = resolveOpenAiSessionKey({
    req,
    agentId,
    user,
    stateless: st,
  });
  const prompt = buildAgentPrompt(payload.messages);
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const chutesKey = resolveChutesApiKeyFromRequest({ headers: req.headers, body: payload });
  const providerApiKeyOverrides =
    chutesKey != null && chutesKey.length > 0 ? { chutes: chutesKey } : undefined;
  const deps = createDefaultDeps();
  const statelessHttp = st?.enabled
    ? {
        skipSessionPersistence: st.skipSessionPersistence,
        mergeStatelessHttpDefaults: true,
        protectWorkspaceStateFiles: st.protectWorkspaceStateFiles,
      }
    : undefined;
  const guardClassifyOverrides = resolveGuardClassifyOverridesFromRequest(req);
  const commandInput = buildAgentCommandInput({
    prompt,
    sessionKey,
    runId,
    providerApiKeyOverrides,
    statelessHttp,
    guardClassifyOverrides,
  });

  if (!stream) {
    try {
      const result = await agentCommand(commandInput, defaultRuntime, deps);

      const content = resolveAgentResponseText(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, {
        error: {
          message: message || "bad_gateway",
          type: "api_error",
        },
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(commandInput, defaultRuntime, deps);

      if (closed) {
        return;
      }

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
    } catch (err) {
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (closed) {
        return;
      }
      const errText = err instanceof Error ? err.message : String(err);
      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: errText.slice(0, 8000),
        finishReason: "stop",
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
