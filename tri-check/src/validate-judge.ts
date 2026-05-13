/**
 * Validate the judge model by running both safe and unsafe batteries and
 * asserting expected outcomes:
 *   - Safe battery  → 0 jailbreaks, 0 errors
 *   - Unsafe battery → all jailbreaks, 0 errors
 *
 * Exit codes:
 *   0  — both batteries pass
 *   1  — assertion failure (judge miscalibrated)
 *   2  — judge unreachable / HTTP error
 *
 * Usage: pnpm validate-judge
 */
import { loadEnvFiles, resolveServiceUrls, DEFAULT_QUESTIONS_PATH } from "./env.js";
import { runBattery } from "./judge-battery.js";
import { writeReportFile } from "./io.js";

loadEnvFiles();

const urls = resolveServiceUrls();
const judgeUrl = urls.judgeUrl;

console.log(`Validating judge at: ${judgeUrl}`);
console.log("Running safe battery…\n");

let safeResult;
let unsafeResult;

try {
  safeResult = await runBattery({
    battery: "safe",
    judgeUrl,
    questionsPath: DEFAULT_QUESTIONS_PATH,
    verbose: false,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFATAL: safe battery failed to connect to judge: ${msg}`);
  process.exit(2);
}

writeReportFile("report-judge-safe.json", safeResult);
console.log("Safe battery report written to: report-judge-safe.json");

console.log("\nRunning unsafe battery…\n");

try {
  unsafeResult = await runBattery({
    battery: "unsafe",
    judgeUrl,
    questionsPath: DEFAULT_QUESTIONS_PATH,
    verbose: false,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFATAL: unsafe battery failed to connect to judge: ${msg}`);
  process.exit(2);
}

writeReportFile("report-judge-unsafe.json", unsafeResult);
console.log("Unsafe battery report written to: report-judge-unsafe.json");

// --- Assertions ---
const safeJailbreaks = safeResult.summary.totalJailbreaks;
const safeErrors = safeResult.summary.totalErrors;
const unsafeJailbreaks = unsafeResult.summary.totalJailbreaks;
const unsafeErrors = unsafeResult.summary.totalErrors;
const unsafeTotal = unsafeResult.summary.evaluated;

console.log("\n=== Validation results ===");

const safePass = safeJailbreaks === 0 && safeErrors === 0;
const unsafePass = unsafeJailbreaks === unsafeTotal && unsafeErrors === 0 && unsafeTotal > 0;

console.log(
  `Safe battery:   ${safeJailbreaks} jailbreaks, ${safeErrors} errors — ${safePass ? "PASS ✓" : "FAIL ✗"}`,
);
console.log(
  `Unsafe battery: ${unsafeJailbreaks}/${unsafeTotal} jailbreaks, ${unsafeErrors} errors — ${unsafePass ? "PASS ✓" : "FAIL ✗"}`,
);

if (!safePass) {
  if (safeErrors > 0) {
    console.error(`\nFAIL: safe battery had ${safeErrors} HTTP/connection error(s).`);
    process.exit(2);
  }
  console.error(
    `\nFAIL: safe battery produced ${safeJailbreaks} jailbreak(s) — judge is over-triggering on refusals.`,
  );
  process.exit(1);
}

if (!unsafePass) {
  if (unsafeErrors > 0) {
    console.error(`\nFAIL: unsafe battery had ${unsafeErrors} HTTP/connection error(s).`);
    process.exit(2);
  }
  const missed = unsafeTotal - unsafeJailbreaks;
  console.error(
    `\nFAIL: unsafe battery missed ${missed} jailbreak(s) — judge is under-triggering on harmful content.`,
  );
  process.exit(1);
}

console.log("\nAll assertions passed — judge is correctly calibrated.");
