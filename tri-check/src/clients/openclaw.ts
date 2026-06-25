import { openClawLocalGuardHeaders, type ResolvedServiceUrls } from "../env.js";
import { requestJson } from "../http.js";

const RATE_LIMIT_HINT_RE = /(?:^|\b)(?:http\s*429|429\b|rate limit|too many requests|quota|throttl)/i;

export type CallOpenClawOptions = {
  /** Route guard-model classify to local Halo (OpenClaw reads these headers; main model still uses Chutes if configured). */
  localGuard?: boolean;
  /** Skip guard-model input/output checks for this request only. */
  disableGuard?: boolean;
};

function authHeaders(urls: ResolvedServiceUrls, options?: CallOpenClawOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (urls.openclawToken) {
    headers.Authorization = `Bearer ${urls.openclawToken}`;
  }
  if (urls.chutesApiKey) {
    headers["X-Chutes-Api-Key"] = urls.chutesApiKey;
  }
  if (urls.openrouterApiKey) {
    headers["X-OpenRouter-Api-Key"] = urls.openrouterApiKey;
  }
  if (options?.localGuard) {
    Object.assign(headers, openClawLocalGuardHeaders());
  }
  if (options?.disableGuard) {
    headers["X-Openclaw-Guard-Disable"] = "1";
  }
  return headers;
}

export async function callOpenClaw(
  baseUrl: string,
  urls: ResolvedServiceUrls,
  prompt: string,
  options?: CallOpenClawOptions,
): Promise<string> {
  const EMPTY_RESPONSE_FALLBACK = "No response from OpenClaw.";
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body = {
    model: "openclaw:main",
    messages: [{ role: "user", content: prompt }],
  };
  const res = await requestJson<{
    choices?: Array<{ message?: { content?: string } }>;
  }>("POST", url, body, authHeaders(urls, options));
  const content = res?.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new Error(`OpenClaw response missing choices[0].message.content: ${JSON.stringify(res)}`);
  }
  const text = String(content);
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("OpenClaw returned empty assistant output.");
  }
  if (trimmed === EMPTY_RESPONSE_FALLBACK) {
    throw new Error(
      "OpenClaw returned empty assistant output (gateway fallback: No response from OpenClaw.)",
    );
  }
  if (RATE_LIMIT_HINT_RE.test(trimmed)) {
    throw new Error(`OpenClaw returned a rate-limit response body: ${trimmed.slice(0, 400)}`);
  }
  return text;
}
