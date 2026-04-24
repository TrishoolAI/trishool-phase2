import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_LOCAL_GUARD_CLASSIFY_URL,
  DEFAULT_QUESTIONS_PATH,
  loadEnvFiles,
  resolveServiceUrls,
  TRI_CHECK_ROOT,
} from "./env.js";
import { collectFixtureRedactStrings, loadGroundTruthQuestionsById } from "./groundTruth.js";
import { writeReportFile } from "./io.js";
import { logChutesKey, printRunSummary, runDirect, runFromSubmission } from "./run.js";

function usage(): string {
  return `
tri-check — run OpenClaw → Judge and print a clear per-question flow log.

Usage:
  pnpm eval --submission <file.json>
  pnpm eval --submission <file.json> --questions <path>
  pnpm eval --question Q1 --prompt "Your prompt here"

Options:
  --submission <path>   Submission JSON (keys Q1..Qn, alignet-style; technique/url/MCP optional)
  --questions <path>    Question rubric JSON (array or { "questions": [] }). Default: <tri-check>/data/questions.json
  --question <id>       Single question id (e.g. Q1); requires --prompt
  --prompt <text>       Prompt to send to OpenClaw
  --url <url>           OpenClaw base URL (same as --openclaw-url)
  --openclaw-url <url> Override OPENCLAW_URL
  --judge-url <url>    Override JUDGE_URL
  --out <path>         Write JSON report to this path
  --local              Use local Halo guard only (OpenClaw still runs agent on Chutes); set HALO_LOCAL_CLASSIFY_URL if gateway is in Docker
  --verbose            Extra stderr diagnostics (redact secrets by default)
  -h, --help           Show this help

Env (see .env.example):
  OPENCLAW_URL, OPENCLAW_GATEWAY_PASSWORD or OPENCLAW_GATEWAY_TOKEN,
  JUDGE_URL, CHUTES_API_KEY (optional), OPENROUTER_API_KEY (optional),
  JUDGE_LLM_PROVIDER=chutes|openrouter (default chutes; must match tri-judge judge.provider)
  TRISHOOL_EVAL_GROUND_TRUTH — path to ground-truth.json (optional; default ../tri-claw/docker/eval-fixtures/)
  TRI_CHECK_NO_GROUND_TRUTH=1 — do not merge fixture ground truth (use rubric file only)
  TRI_CHECK_REDACT_FIXTURE_OUTPUT=1 — redact ground-truth substrings in printed output only (judge still sees raw model text by default)

Examples:
  cd tri-check && pnpm install && pnpm eval --submission ../alignet/cli/my_submission.json
  cd tri-check && pnpm eval --question Q1 --prompt "Hello"

Note: With npm, use: npm run eval -- --question Q1 --prompt "hi"
`.trim();
}

function resolveQuestionsPath(explicit: string | undefined): { path: string; isDefault: boolean } {
  if (explicit !== undefined && explicit.trim() !== "") {
    return { path: path.resolve(explicit), isDefault: false };
  }
  return { path: DEFAULT_QUESTIONS_PATH, isDefault: true };
}

interface ParsedCli {
  submission?: string;
  questions?: string;
  question?: string;
  prompt?: string;
  openclawUrl?: string;
  judgeUrl?: string;
  out?: string;
  verbose: boolean;
  localGuard: boolean;
  help: boolean;
}

function parseCli(argv: string[]): ParsedCli {
  const out: ParsedCli = { verbose: false, localGuard: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value after ${a}`);
      return v;
    };

    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--verbose") {
      out.verbose = true;
      continue;
    }
    if (a === "--local") {
      out.localGuard = true;
      continue;
    }
    if (a === "--submission") {
      out.submission = take();
      continue;
    }
    if (a === "--questions") {
      out.questions = take();
      continue;
    }
    if (a === "--question") {
      out.question = take();
      continue;
    }
    if (a === "--prompt") {
      out.prompt = take();
      continue;
    }
    if (a === "--url" || a === "--openclaw-url") {
      out.openclawUrl = take();
      continue;
    }
    if (a === "--judge-url") {
      out.judgeUrl = take();
      continue;
    }
    if (a === "--out") {
      out.out = take();
      continue;
    }
    if (a.startsWith("--submission=")) {
      out.submission = a.slice("--submission=".length);
      continue;
    }
    if (a.startsWith("--questions=")) {
      out.questions = a.slice("--questions=".length);
      continue;
    }
    if (a.startsWith("--question=")) {
      out.question = a.slice("--question=".length);
      continue;
    }
    if (a.startsWith("--prompt=")) {
      out.prompt = a.slice("--prompt=".length);
      continue;
    }
    if (a.startsWith("--openclaw-url=") || a.startsWith("--url=")) {
      const eq = a.indexOf("=");
      out.openclawUrl = a.slice(eq + 1);
      continue;
    }
    if (a.startsWith("--judge-url=")) {
      out.judgeUrl = a.slice("--judge-url=".length);
      continue;
    }
    if (a.startsWith("--out=")) {
      out.out = a.slice("--out=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${a}\n\n${usage()}`);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvFiles();
  // pnpm forwards `pnpm eval -- <args>` including a literal `--` separator; ignore it.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
    return;
  }

  if (parsed.help || argv.length === 0) {
    console.log(usage());
    if (argv.length === 0) process.exitCode = 1;
    return;
  }

  const urls = resolveServiceUrls({
    openclawUrl: parsed.openclawUrl,
    judgeUrl: parsed.judgeUrl,
  });

  const groundTruthLoaded = loadGroundTruthQuestionsById();
  const groundTruthById = groundTruthLoaded?.byId;
  const fixtureRedact = groundTruthById ? collectFixtureRedactStrings(groundTruthById) : [];
  if (groundTruthLoaded) {
    process.stderr.write(
      `[tri-check] Judge rubric overlay: ${groundTruthLoaded.byId.size} question(s) from ${groundTruthLoaded.path}\n`,
    );
  }

  const options = {
    openclawUrl: urls.openclawUrl,
    judgeUrl: urls.judgeUrl,
    urls,
    verbose: parsed.verbose,
    localGuard: parsed.localGuard,
    groundTruthById,
    fixtureRedact,
  };

  logChutesKey(urls);
  if (parsed.localGuard) {
    const classifyUrl = (process.env.HALO_LOCAL_CLASSIFY_URL ?? DEFAULT_LOCAL_GUARD_CLASSIFY_URL).trim();
    process.stderr.write(
      `[tri-check] --local: OpenClaw will POST guard classify to ${classifyUrl} (this URL is fetched from the OpenClaw gateway process, not from tri-check).\n`,
    );
    if (classifyUrl.includes("127.0.0.1") || classifyUrl.includes("localhost")) {
      process.stderr.write(
        `[tri-check] If OpenClaw runs in Docker and you see OpenClaw HTTP 502 "fetch failed", set HALO_LOCAL_CLASSIFY_URL=http://host.docker.internal:8000/v1/classify (Mac/Win Docker Desktop) so the container can reach the host guard.\n`,
      );
    }
  }

  const hasSubmission = Boolean(parsed.submission);
  const hasDirect = Boolean(parsed.question || parsed.prompt);
  if (hasSubmission && hasDirect) {
    console.error("Use either --submission mode OR --question/--prompt, not both.");
    process.exit(1);
    return;
  }
  if (hasSubmission) {
    if (!fs.existsSync(path.resolve(parsed.submission!))) {
      console.error(`Submission file not found: ${parsed.submission}`);
      process.exit(1);
      return;
    }
    const q = resolveQuestionsPath(parsed.questions);
    if (!fs.existsSync(q.path)) {
      console.error(
        `Questions file not found: ${q.path}${q.isDefault ? ` (default: ${path.relative(TRI_CHECK_ROOT, DEFAULT_QUESTIONS_PATH) || "data/questions.json"} under tri-check; pass --questions or add the file)` : ""}`,
      );
      process.exit(1);
      return;
    }
    if (q.isDefault) {
      process.stderr.write(`[tri-check] Using default questions: ${q.path}\n`);
    }
    const report = await runFromSubmission({
      submissionPath: parsed.submission!,
      questionsPath: q.path,
      options,
    });
    printRunSummary(report);
    if (parsed.out) writeReportFile(parsed.out, report);
    const code = report.summary.totalErrors > 0 ? 1 : 0;
    process.exit(code);
    return;
  }

  if (parsed.question) {
    if (parsed.prompt === undefined) {
      console.error("--question requires --prompt");
      process.exit(1);
      return;
    }
    const q = resolveQuestionsPath(parsed.questions);
    if (!fs.existsSync(q.path)) {
      console.error(
        `Questions file not found: ${q.path}${q.isDefault ? ` (default under tri-check; pass --questions or add the file)` : ""}`,
      );
      process.exit(1);
      return;
    }
    if (q.isDefault) {
      process.stderr.write(`[tri-check] Using default questions: ${q.path}\n`);
    }
    const report = await runDirect({
      questionId: parsed.question,
      prompt: parsed.prompt,
      questionsPath: q.path,
      options,
    });
    printRunSummary(report);
    if (parsed.out) writeReportFile(parsed.out, report);
    const code = report.summary.totalErrors > 0 ? 1 : 0;
    process.exit(code);
    return;
  }

  console.error("Invalid invocation. Provide --submission, or --question + --prompt.\n");
  console.log(usage());
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
