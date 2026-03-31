import { callJudge, isSuccessfulJailbreak } from "./clients/judge.js";
import { callOpenClaw } from "./clients/openclaw.js";
import { formatChutesKeyForLog, redactSecrets, redactSecretsFromObject, type ResolvedServiceUrls } from "./env.js";
import { overlayMetaLookup } from "./groundTruth.js";
import { indexQuestionsById, loadQuestionsFromPath, loadSubmission } from "./io.js";
import type {
  CliOutputReport,
  PerQuestionResult,
  QuestionMeta,
  SubmissionEntry,
} from "./types.js";

export interface RunOptions {
  /** Default OpenClaw base; per-entry `url` overrides when non-empty. */
  openclawUrl: string;
  judgeUrl: string;
  urls: ResolvedServiceUrls;
  verbose: boolean;
  /** Optional: same `questions` map as validator `ground-truth.json` — merges judge secrets / expected_unsafe. */
  groundTruthById?: Map<string, QuestionMeta>;
  /** Substrings from ground truth for log redaction. */
  fixtureRedact?: string[];
}

function metaForId(
  id: string,
  byId: Map<string, QuestionMeta> | undefined,
  groundTruthById?: Map<string, QuestionMeta>,
): { objective: string; expectedSafe: string; expectedUnsafe: string; secrets?: string[] } {
  const q =
    byId?.get(id) ?? byId?.get(id.toUpperCase()) ?? byId?.get(id.toLowerCase());
  const gt = overlayMetaLookup(id, groundTruthById);
  let expectedUnsafe = q?.expected_unsafe_output ?? "";
  let secrets = q?.ground_truth_secrets;
  if (gt) {
    if (gt.ground_truth_secrets !== undefined && Array.isArray(gt.ground_truth_secrets)) {
      secrets = gt.ground_truth_secrets;
    }
    if (gt.expected_unsafe_output !== undefined && gt.expected_unsafe_output.trim() !== "") {
      expectedUnsafe = gt.expected_unsafe_output;
    }
  }
  return {
    objective: q?.objective ?? q?.question_id ?? q?.id ?? id,
    expectedSafe: q?.expected_safe_behavior ?? "",
    expectedUnsafe,
    secrets,
  };
}

function isBlankPrompt(p: string | undefined): boolean {
  return p === undefined || String(p).trim() === "";
}

function mcpField(entry: SubmissionEntry): string | undefined {
  const m = entry.MCP ?? entry.mcp;
  return m !== undefined && String(m).trim() !== "" ? String(m) : undefined;
}

function printVerbose(label: string, obj: unknown): void {
  process.stderr.write(`[tri-check][verbose] ${label}: ${JSON.stringify(obj, null, 2)}\n`);
}

function printSection(title: string, body: string): void {
  process.stdout.write(`${title}:\n`);
  process.stdout.write(`${"-".repeat(title.length + 1)}\n`);
  process.stdout.write(`${body || "(none)"}\n\n`);
}

function printQuestionStart(r: {
  id: string;
  objective: string;
  promptSubmitted: string;
  openclawUrlUsed: string;
  metadata?: {
    technique?: string;
    submissionUrl?: string;
    mcp?: string;
  };
}): void {
  process.stdout.write(`===== ${r.id} =====\n\n`);
  printSection("Objective", r.objective || "(none)");
  printSection("Prompt submitted", r.promptSubmitted || "(empty)");
  if (r.metadata?.technique) printSection("Technique (metadata)", r.metadata.technique);
  if (r.metadata?.submissionUrl) printSection("Submission URL (metadata)", r.metadata.submissionUrl);
  if (r.metadata?.mcp) printSection("MCP (metadata)", r.metadata.mcp);
  printSection("OpenClaw URL used", r.openclawUrlUsed);
}

function printQuestionEndSeparator(): void {
  process.stdout.write("------------------------------------------------------------\n");
}

export function formatQuestionBlock(r: PerQuestionResult): string {
  const addSection = (lines: string[], heading: string, body: string) => {
    lines.push(`${heading}:`);
    lines.push("-".repeat(heading.length + 1));
    lines.push(body || "(none)");
    lines.push("");
  };

  const lines: string[] = [];
  lines.push(`===== ${r.id} =====`);
  lines.push("");
  addSection(lines, "Objective", r.objective || "(none)");
  addSection(lines, "Prompt submitted", r.promptSubmitted || "(empty)");
  if (r.metadata?.technique) {
    addSection(lines, "Technique (metadata)", r.metadata.technique);
  }
  if (r.metadata?.submissionUrl) {
    addSection(lines, "Submission URL (metadata)", r.metadata.submissionUrl);
  }
  if (r.metadata?.mcp) {
    addSection(lines, "MCP (metadata)", r.metadata.mcp);
  }
  addSection(lines, "OpenClaw URL used", r.openclawUrlUsed);
  if (r.skipped) {
    addSection(lines, "Skipped", r.skipReason ?? "yes");
    lines.push("");
    return lines.join("\n");
  }
  if (r.error) {
    addSection(lines, "Error", r.error);
    lines.push("");
    return lines.join("\n");
  }
  addSection(lines, "OpenClaw Response", r.openclawResponse);
  addSection(
    lines,
    "Judge Response",
    `verdict=${r.judgeVerdict ?? "(none)"} score=${r.judgeScore} reasoning=${r.judgeReasoning ?? "(none)"}`,
  );
  addSection(lines, "Successful Jailbreak", r.successfulJailbreak ? "yes" : "no");
  lines.push("");
  return lines.join("\n");
}

function sortQuestionIds(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const na = parseInt(/\d+/.exec(a)?.[0] ?? "NaN", 10);
    const nb = parseInt(/\d+/.exec(b)?.[0] ?? "NaN", 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

async function evaluateOne(params: {
  id: string;
  prompt: string;
  openclawBase: string;
  judgeBase: string;
  urls: ResolvedServiceUrls;
  meta: ReturnType<typeof metaForId>;
  submissionMeta?: SubmissionEntry;
  verbose: boolean;
  fixtureRedact: string[];
}): Promise<PerQuestionResult> {
  const { id, prompt, openclawBase, judgeBase, urls, meta, submissionMeta, verbose, fixtureRedact } = params;
  const metadata = submissionMeta
    ? {
        technique: submissionMeta.technique,
        submissionUrl: submissionMeta.url,
        mcp: mcpField(submissionMeta),
      }
    : undefined;

  printQuestionStart({
    id,
    objective: meta.objective,
    promptSubmitted: prompt ?? "",
    openclawUrlUsed: openclawBase,
    metadata,
  });

  if (isBlankPrompt(prompt)) {
    printSection("Skipped", "missing or empty prompt");
    printQuestionEndSeparator();
    return {
      id,
      objective: meta.objective,
      promptSubmitted: prompt ?? "",
      openclawUrlUsed: openclawBase,
      openclawResponse: "",
      judgeScore: 0,
      successfulJailbreak: false,
      skipped: true,
      skipReason: "missing or empty prompt",
      metadata,
    };
  }

  let openclawResponse: string;
  try {
    if (verbose) {
      printVerbose(`${id} OpenClaw request`, { base: openclawBase, promptLength: prompt.length });
    }
    openclawResponse = redactSecrets(
      await callOpenClaw(openclawBase, urls, prompt),
      urls,
      fixtureRedact,
    );
    if (verbose) {
      printVerbose(`${id} OpenClaw response preview`, {
        length: openclawResponse.length,
        preview: openclawResponse.slice(0, 500),
      });
    }
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : String(e), urls, fixtureRedact);
    printSection("Error", `OpenClaw: ${msg}`);
    printQuestionEndSeparator();
    return {
      id,
      objective: meta.objective,
      promptSubmitted: prompt,
      openclawUrlUsed: openclawBase,
      openclawResponse: "",
      judgeScore: 0,
      successfulJailbreak: false,
      error: `OpenClaw: ${msg}`,
      metadata,
    };
  }

  printSection("OpenClaw Response", openclawResponse);

  try {
    const judgeResultRaw = await callJudge(judgeBase, urls, {
      questionId: id,
      prompt,
      modelResponse: openclawResponse,
      expectedSafe: meta.expectedSafe,
      expectedUnsafe: meta.expectedUnsafe,
      groundTruthSecrets: meta.secrets,
    });
    const judgeResult = redactSecretsFromObject(judgeResultRaw, urls, fixtureRedact);
    if (verbose) {
      printVerbose(`${id} Judge result`, judgeResult);
    }
    const jailbreak = isSuccessfulJailbreak(judgeResult);
    printSection(
      "Judge Response",
      `verdict=${judgeResult.judgeVerdict ?? "(none)"} score=${judgeResult.score} reasoning=${judgeResult.judgeReasoning ?? "(none)"}`,
    );
    printSection("Successful Jailbreak", jailbreak ? "yes" : "no");
    printQuestionEndSeparator();
    return {
      id,
      objective: meta.objective,
      promptSubmitted: prompt,
      openclawUrlUsed: openclawBase,
      openclawResponse,
      judgeVerdict: judgeResult.judgeVerdict,
      judgeScore: judgeResult.score,
      judgeReasoning: judgeResult.judgeReasoning,
      successfulJailbreak: jailbreak,
      metadata,
    };
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : String(e), urls, fixtureRedact);
    printSection("Error", `Judge: ${msg}`);
    printQuestionEndSeparator();
    return {
      id,
      objective: meta.objective,
      promptSubmitted: prompt,
      openclawUrlUsed: openclawBase,
      openclawResponse,
      judgeScore: 0,
      successfulJailbreak: false,
      error: `Judge: ${msg}`,
      metadata,
    };
  }
}

export async function runFromSubmission(args: {
  submissionPath: string;
  questionsPath: string;
  options: RunOptions;
}): Promise<CliOutputReport> {
  const submission = loadSubmission(args.submissionPath);
  const questions = loadQuestionsFromPath(args.questionsPath);
  const byId = indexQuestionsById(questions);
  const ids = sortQuestionIds(Object.keys(submission));
  const results: PerQuestionResult[] = [];

  for (const id of ids) {
    const entry = submission[id];
    if (!entry || typeof entry !== "object") {
      results.push({
        id,
        objective: metaForId(id, byId, args.options.groundTruthById).objective,
        promptSubmitted: "",
        openclawUrlUsed: args.options.openclawUrl,
        openclawResponse: "",
        judgeScore: 0,
        successfulJailbreak: false,
        skipped: true,
        skipReason: "invalid submission entry",
      });
      continue;
    }
    const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
    const perUrl = entry.url !== undefined && String(entry.url).trim() !== "" ? String(entry.url).replace(/\/$/, "") : undefined;
    const openclawBase = perUrl ?? args.options.openclawUrl;
    const meta = metaForId(id, byId, args.options.groundTruthById);
    const r = await evaluateOne({
      id,
      prompt,
      openclawBase,
      judgeBase: args.options.judgeUrl,
      urls: args.options.urls,
      meta,
      submissionMeta: entry,
      verbose: args.options.verbose,
      fixtureRedact: args.options.fixtureRedact ?? [],
    });
    results.push(r);
  }

  return summarizeReport(results);
}

export async function runDirect(args: {
  questionId: string;
  prompt: string;
  questionsPath?: string;
  options: RunOptions;
}): Promise<CliOutputReport> {
  let byId: Map<string, QuestionMeta> | undefined;
  if (args.questionsPath) {
    const questions = loadQuestionsFromPath(args.questionsPath);
    byId = indexQuestionsById(questions);
  }
  const meta = metaForId(args.questionId, byId, args.options.groundTruthById);
  if (!args.questionsPath) {
    process.stderr.write(
      "[tri-check] note: no --questions file; judge expected safe/unsafe text may be empty — scoring may be less meaningful.\n",
    );
  }
  const r = await evaluateOne({
    id: args.questionId,
    prompt: args.prompt,
    openclawBase: args.options.openclawUrl,
    judgeBase: args.options.judgeUrl,
    urls: args.options.urls,
    meta,
    verbose: args.options.verbose,
    fixtureRedact: args.options.fixtureRedact ?? [],
  });
  return summarizeReport([r]);
}

function summarizeReport(results: PerQuestionResult[]): CliOutputReport {
  const totalJailbreaks = results.filter((r) => r.successfulJailbreak).length;
  const totalErrors = results.filter((r) => r.error).length;
  const totalSkipped = results.filter((r) => r.skipped).length;
  const evaluated = results.filter((r) => !r.skipped && !r.error).length;
  return {
    summary: {
      totalQuestions: results.length,
      evaluated,
      totalJailbreaks,
      totalErrors,
      totalSkipped,
    },
    results,
  };
}

export function printRunSummary(report: CliOutputReport): void {
  const s = report.summary;
  process.stdout.write("\n=== Run summary ===\n");
  process.stdout.write(`Total questions: ${s.totalQuestions}\n`);
  process.stdout.write(`Evaluated (OpenClaw + Judge, no error): ${s.evaluated}\n`);
  process.stdout.write(`Successful jailbreaks: ${s.totalJailbreaks}\n`);
  process.stdout.write(`Errors: ${s.totalErrors}\n`);
  process.stdout.write(`Skipped: ${s.totalSkipped}\n`);
}

export function logChutesKey(urls: ResolvedServiceUrls): void {
  if (process.env.TRI_CHECK_REVEAL_CHUTES_KEY === "1" || process.env.EVAL_REVEAL_CHUTES_KEY === "1") {
    process.stderr.write(
      "[tri-check] TRI_CHECK_REVEAL_CHUTES_KEY/EVAL_REVEAL_CHUTES_KEY=1: full X-Chutes-Api-Key may appear in verbose logs.\n",
    );
  }
  process.stderr.write(`[tri-check] X-Chutes-Api-Key will send: ${formatChutesKeyForLog(urls.chutesApiKey)}\n`);
}
