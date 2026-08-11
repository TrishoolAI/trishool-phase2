import fs from "node:fs";
import path from "node:path";
import type { QuestionMeta, SubmissionFile } from "./types.js";

export function readJsonFile<T>(filePath: string): T {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw) as T;
}

export function loadQuestionsFromPath(filePath: string): QuestionMeta[] {
  const data = readJsonFile<unknown>(filePath);
  if (Array.isArray(data)) {
    return data as QuestionMeta[];
  }
  if (
    data &&
    typeof data === "object" &&
    "questions" in data &&
    Array.isArray((data as { questions: unknown }).questions)
  ) {
    return (data as { questions: QuestionMeta[] }).questions;
  }
  throw new Error(
    `Invalid questions file: ${filePath} — expected a JSON array or { "questions": [...] }`,
  );
}

/** Resolve question key: `question_id` preferred, then legacy `id`. */
export function questionKey(q: QuestionMeta): string {
  const k = q.question_id ?? q.id;
  if (!k || String(k).trim() === "") {
    throw new Error("Question entry must include question_id (or legacy id)");
  }
  return String(k);
}

export function indexQuestionsById(questions: QuestionMeta[]): Map<string, QuestionMeta> {
  return new Map(questions.map((q) => [questionKey(q), q]));
}

/**
 * Sort question ids numerically where possible so Q2 precedes Q10.
 * Shared by the eval loop and the judge battery so both walk questions in the
 * same order for any question count.
 */
export function sortQuestionIds(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const na = parseInt(/\d+/.exec(a)?.[0] ?? "NaN", 10);
    const nb = parseInt(/\d+/.exec(b)?.[0] ?? "NaN", 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

/**
 * Question ids to evaluate, driven by the rubric rather than by whatever
 * fixture file happens to be loaded.
 *
 * `available` (canned answers, a submission body) may legitimately be a
 * superset -- fixtures outlive the rubric they were generated against. Taking
 * ids from the rubric and intersecting means trimming questions.json to N
 * automatically narrows every consumer, instead of leaving callers to evaluate
 * ids the rubric no longer defines with empty expected-output text.
 */
export function rubricQuestionIds(
  questions: QuestionMeta[],
  available?: Record<string, unknown>,
): string[] {
  const ids = sortQuestionIds(questions.map((q) => questionKey(q)));
  return available ? ids.filter((id) => id in available) : ids;
}

export function loadSubmission(path: string): SubmissionFile {
  const data = readJsonFile<unknown>(path);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `Invalid submission file: ${path} — expected a JSON object (Q1..Qn entries, or {"prompt": "... {{objective}} ..."})`,
    );
  }
  return data as SubmissionFile;
}

export function writeReportFile(filePath: string, report: unknown): void {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(report, null, 2), "utf8");
}
