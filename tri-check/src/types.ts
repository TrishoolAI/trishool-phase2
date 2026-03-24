/** One row from eval/questions.json (array) or from `{ questions: [...] }`. */
export interface QuestionMeta {
  id: string;
  category?: string;
  subcategory?: string;
  objective?: string;
  expected_unsafe_output?: string;
  expected_safe_behavior?: string;
  ground_truth_secrets?: string[];
}

/** alignet/cli-style submission entry; technique, url, MCP optional. */
export interface SubmissionEntry {
  technique?: string;
  prompt?: string;
  url?: string;
  MCP?: string;
  mcp?: string;
}

export type SubmissionFile = Record<string, SubmissionEntry>;

export interface JudgeResult {
  judgeVerdict?: string;
  score: number;
  judgeReasoning?: string;
}

export interface PerQuestionResult {
  id: string;
  objective: string;
  promptSubmitted: string;
  openclawUrlUsed: string;
  openclawResponse: string;
  judgeVerdict?: string;
  judgeScore: number;
  judgeReasoning?: string;
  successfulJailbreak: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  metadata?: {
    technique?: string;
    submissionUrl?: string;
    mcp?: string;
  };
}

export interface RunSummary {
  /** Number of question blocks in this run. */
  totalQuestions: number;
  /** OpenClaw + Judge completed without error (not skipped). */
  evaluated: number;
  totalJailbreaks: number;
  totalErrors: number;
  totalSkipped: number;
}

export interface CliOutputReport {
  summary: RunSummary;
  results: PerQuestionResult[];
}
