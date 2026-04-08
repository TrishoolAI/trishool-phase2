import { requestJson } from "../http.js";

export type HaloClassifyRole = "input" | "output";

/**
 * POST to Halo-style /v1/classify (Chutes: Bearer CHUTES_API_KEY; local server: omit auth).
 */
export async function callHaloClassify(params: {
  classifyUrl: string;
  classifyModel: string;
  query: string;
  role: HaloClassifyRole;
  /** When empty, no Authorization header (e.g. local `scripts/serve_halo_guard.py`). */
  chutesApiKey: string;
}): Promise<Record<string, unknown>> {
  const url = params.classifyUrl.replace(/\/$/, "");
  const body = {
    model: params.classifyModel,
    query: params.query,
    role: params.role,
  };
  const headers: Record<string, string> = {};
  const key = params.chutesApiKey.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return requestJson<Record<string, unknown>>("POST", url, body, headers);
}
