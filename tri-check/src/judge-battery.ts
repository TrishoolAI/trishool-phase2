/**
 * Judge-only battery: calls POST /v1/judge/evaluate with canned modelResponse
 * text to validate the judge model without agent/OpenClaw variance.
 *
 * Usage:
 *   pnpm judge-battery -- --battery safe   [--out report.json] [--judge-url url] [--questions path] [--verbose]
 *   pnpm judge-battery -- --battery unsafe [--out report.json]
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_QUESTIONS_PATH, TRI_CHECK_ROOT, loadEnvFiles, resolveServiceUrls } from "./env.js";
import { callJudge, isSuccessfulJailbreak } from "./clients/judge.js";
import { indexQuestionsById, loadQuestionsFromPath, writeReportFile } from "./io.js";
import type { JudgeResult, PerQuestionResult, RunSummary } from "./types.js";

loadEnvFiles();

type Battery = "safe" | "unsafe";

interface BatteryArgs {
  battery: Battery;
  out?: string;
  judgeUrl?: string;
  questionsPath: string;
  verbose: boolean;
}

function parseCli(argv: string[]): BatteryArgs {
  const out: Partial<BatteryArgs> & { verbose: boolean } = {
    questionsPath: DEFAULT_QUESTIONS_PATH,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value after ${a}`);
      return v;
    };
    if (a === "--battery") {
      const v = take();
      if (v !== "safe" && v !== "unsafe") throw new Error(`--battery must be "safe" or "unsafe", got: ${v}`);
      out.battery = v;
    } else if (a === "--out") {
      out.out = take();
    } else if (a === "--judge-url") {
      out.judgeUrl = take();
    } else if (a === "--questions") {
      out.questionsPath = path.resolve(take());
    } else if (a === "--verbose") {
      out.verbose = true;
    }
  }
  if (!out.battery) {
    console.error("Usage: pnpm judge-battery -- --battery safe|unsafe [--out path] [--judge-url url] [--verbose]");
    process.exit(1);
  }
  return out as BatteryArgs;
}

function loadCannedResponses(battery: Battery): Record<string, string> {
  const file = path.join(TRI_CHECK_ROOT, "data", `judge-battery-${battery}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Canned responses file not found: ${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
}

function loadObjectivesSubmission(): Record<string, { prompt?: string }> {
  const file = path.join(TRI_CHECK_ROOT, "data", "objectives-submission.json");
  if (!fs.existsSync(file)) {
    console.error(`objectives-submission.json not found: ${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, { prompt?: string }>;
}

export interface BatteryResult {
  summary: RunSummary;
  results: PerQuestionResult[];
}

export async function runBattery(args: {
  battery: Battery;
  judgeUrl: string;
  questionsPath: string;
  verbose: boolean;
}): Promise<BatteryResult> {
  const urls = resolveServiceUrls({ judgeUrl: args.judgeUrl });
  const questions = loadQuestionsFromPath(args.questionsPath);
  const byId = indexQuestionsById(questions);
  const canned = loadCannedResponses(args.battery);
  const objectives = loadObjectivesSubmission();

  const results: PerQuestionResult[] = [];
  let evaluated = 0;
  let totalJailbreaks = 0;
  let totalErrors = 0;
  const questionIds = Object.keys(canned).sort();

  for (const qid of questionIds) {
    const modelResponse = canned[qid];
    if (!modelResponse) {
      console.log(`${qid}: no canned response — skipping`);
      results.push({
        id: qid,
        objective: "",
        promptSubmitted: "",
        openclawUrlUsed: "(battery — no openclaw)",
        openclawResponse: "",
        judgeScore: 0,
        successfulJailbreak: false,
        skipped: true,
        skipReason: "no canned response",
      });
      continue;
    }

    const meta = byId.get(qid);
    const objective = meta?.objective ?? "";
    const prompt = objectives[qid]?.prompt ?? objective;
    const expectedSafe = meta?.expected_safe_behavior ?? "";
    const expectedUnsafe = meta?.expected_unsafe_output ?? "";

    console.log(`\n${qid}:`);
    console.log(`Battery: ${args.battery}`);
    if (args.verbose) {
      console.log(`Objective:\n${objective}`);
      console.log(`Canned response (${args.battery}):\n${modelResponse.slice(0, 200)}…`);
    }

    let judgeResult: JudgeResult;
    try {
      judgeResult = await callJudge(urls.judgeUrl, urls, {
        questionId: qid,
        prompt,
        modelResponse,
        expectedSafe,
        expectedUnsafe,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Judge Error: ${msg}`);
      totalErrors++;
      results.push({
        id: qid,
        objective,
        promptSubmitted: prompt,
        openclawUrlUsed: "(battery — no openclaw)",
        openclawResponse: modelResponse,
        judgeScore: 0,
        successfulJailbreak: false,
        error: msg,
      });
      continue;
    }

    evaluated++;
    const jailbreak = isSuccessfulJailbreak(judgeResult);
    if (jailbreak) totalJailbreaks++;

    console.log(`Judge Response:`);
    console.log(`  verdict=${judgeResult.judgeVerdict ?? "n/a"} score=${judgeResult.score}`);
    if (judgeResult.judgeReasoning) {
      console.log(`  reasoning=${judgeResult.judgeReasoning.slice(0, 200)}`);
    }
    console.log(`Successful Jailbreak: ${jailbreak ? "yes" : "no"}`);
    console.log("------------------------------------------------------------");

    results.push({
      id: qid,
      objective,
      promptSubmitted: prompt,
      openclawUrlUsed: "(battery — no openclaw)",
      openclawResponse: modelResponse,
      judgeVerdict: judgeResult.judgeVerdict,
      judgeScore: judgeResult.score,
      judgeReasoning: judgeResult.judgeReasoning,
      successfulJailbreak: jailbreak,
    });
  }

  const summary: RunSummary = {
    totalQuestions: questionIds.length,
    evaluated,
    totalJailbreaks,
    totalErrors,
    totalSkipped: questionIds.length - evaluated - totalErrors,
  };

  console.log(`\n=== Battery "${args.battery}" summary ===`);
  console.log(`Total: ${summary.totalQuestions} | Evaluated: ${summary.evaluated} | Jailbreaks: ${summary.totalJailbreaks} | Errors: ${summary.totalErrors}`);

  return { summary, results };
}

// --- CLI entry point ---
const args = parseCli(process.argv.slice(2));
const urls = resolveServiceUrls({ judgeUrl: args.judgeUrl });

const result = await runBattery({
  battery: args.battery,
  judgeUrl: urls.judgeUrl,
  questionsPath: args.questionsPath,
  verbose: args.verbose,
});

if (args.out) {
  writeReportFile(args.out, result);
  console.log(`Report written to: ${args.out}`);
}
