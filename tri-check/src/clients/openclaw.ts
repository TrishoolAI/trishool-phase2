import { requestJson } from "../http.js";
import type { ResolvedServiceUrls } from "../env.js";

function authHeaders(urls: ResolvedServiceUrls): Record<string, string> {
  const headers: Record<string, string> = {};
  if (urls.openclawToken) {
    headers.Authorization = `Bearer ${urls.openclawToken}`;
  }
  if (urls.chutesApiKey) {
    headers["X-Chutes-Api-Key"] = urls.chutesApiKey;
  }
  return headers;
}

export async function callOpenClaw(
  baseUrl: string,
  urls: ResolvedServiceUrls,
  prompt: string,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body = {
    model: "openclaw:main",
    messages: [{ role: "user", content: prompt }],
  };
  const res = await requestJson<{
    choices?: Array<{ message?: { content?: string } }>;
  }>("POST", url, body, authHeaders(urls));
  const content = res?.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new Error(`OpenClaw response missing choices[0].message.content: ${JSON.stringify(res)}`);
  }
  return String(content);
}
