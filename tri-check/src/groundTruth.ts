import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./env.js";
import { readJsonFile } from "./io.js";
import type { QuestionMeta } from "./types.js";

/** Same default / env as alignet `resolve_ground_truth_path` (validator). */
export function resolveGroundTruthPath(): string | null {
  if (process.env.TRI_CHECK_NO_GROUND_TRUTH === "1") return null;
  const env = (process.env.TRISHOOL_EVAL_GROUND_TRUTH || "").trim();
  if (env) {
    return path.isAbsolute(env) ? path.resolve(env) : path.resolve(REPO_ROOT, env);
  }
  return path.join(REPO_ROOT, "tri-claw/docker/eval-fixtures/ground-truth.json");
}

export function overlayMetaLookup(id: string, gt?: Map<string, QuestionMeta>): QuestionMeta | undefined {
  if (!gt) return undefined;
  return gt.get(id) ?? gt.get(id.toUpperCase()) ?? gt.get(id.toLowerCase());
}

export function collectFixtureRedactStrings(gt: Map<string, QuestionMeta>): string[] {
  const out: string[] = [];
  for (const q of gt.values()) {
    for (const s of q.ground_truth_secrets ?? []) {
      if (s.length > 0 && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Load `questions` from ground-truth.json for judge overlay (Q7–Q12 dynamic secrets). */
export function loadGroundTruthQuestionsById(): { byId: Map<string, QuestionMeta>; path: string } | undefined {
  const p = resolveGroundTruthPath();
  if (!p || !fs.existsSync(p)) return undefined;
  try {
    const raw = readJsonFile<{ questions?: Record<string, unknown> }>(p);
    const questions = raw.questions;
    if (!questions || typeof questions !== "object") return undefined;
    const m = new Map<string, QuestionMeta>();
    for (const [k, v] of Object.entries(questions)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      const meta: QuestionMeta = { question_id: k };
      let hasOverlay = false;
      if ("ground_truth_secrets" in o && Array.isArray(o.ground_truth_secrets)) {
        meta.ground_truth_secrets = o.ground_truth_secrets.filter((x): x is string => typeof x === "string");
        hasOverlay = true;
      }
      if (
        "expected_unsafe_output" in o &&
        typeof o.expected_unsafe_output === "string" &&
        o.expected_unsafe_output.trim() !== ""
      ) {
        meta.expected_unsafe_output = o.expected_unsafe_output;
        hasOverlay = true;
      }
      if (hasOverlay) m.set(k, meta);
    }
    return m.size > 0 ? { byId: m, path: p } : undefined;
  } catch {
    return undefined;
  }
}
