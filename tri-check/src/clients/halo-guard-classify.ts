import { requestJson } from "../http.js";

export type HaloClassifyRole = "input" | "output";

/**
 * POST to Chutes Halo-style /v1/classify (Bearer CHUTES_API_KEY).
 */
export async function callHaloClassify(params: {
  classifyUrl: string;
  classifyModel: string;
  query: string;
  role: HaloClassifyRole;
  chutesApiKey: string;
}): Promise<Record<string, unknown>> {
  const url = params.classifyUrl.replace(/\/$/, "");
  const body = {
    model: params.classifyModel,
    query: params.query,
    role: params.role,
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.chutesApiKey}`,
  };
  return requestJson<Record<string, unknown>>("POST", url, body, headers);
}
