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

export function indexQuestionsById(questions: QuestionMeta[]): Map<string, QuestionMeta> {
  return new Map(questions.map((q) => [q.id, q]));
}

export function loadSubmission(path: string): SubmissionFile {
  const data = readJsonFile<unknown>(path);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Invalid submission file: ${path} — expected a JSON object keyed by question id (e.g. Q1)`);
  }
  return data as SubmissionFile;
}

export function writeReportFile(filePath: string, report: unknown): void {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(report, null, 2), "utf8");
}
