import { openClawLocalGuardHeaders, type ResolvedServiceUrls } from "../env.js";
import { requestJson } from "../http.js";

export type CallOpenClawOptions = {
  /** Route guard-model classify to local Halo (OpenClaw reads these headers; main model still uses Chutes if configured). */
  localGuard?: boolean;
};

function authHeaders(urls: ResolvedServiceUrls, options?: CallOpenClawOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (urls.openclawToken) {
    headers.Authorization = `Bearer ${urls.openclawToken}`;
  }
  if (urls.chutesApiKey) {
    headers["X-Chutes-Api-Key"] = urls.chutesApiKey;
  }
  if (options?.localGuard) {
    Object.assign(headers, openClawLocalGuardHeaders());
  }
  return headers;
}

export async function callOpenClaw(
  baseUrl: string,
  urls: ResolvedServiceUrls,
  prompt: string,
  options?: CallOpenClawOptions,
): Promise<string> {
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
  return String(content);
}
