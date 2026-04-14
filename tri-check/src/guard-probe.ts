import { callHaloClassify, type HaloClassifyRole } from "./clients/halo-guard-classify.js";
import { callOpenClaw } from "./clients/openclaw.js";
import {
  formatChutesKeyForLog,
  loadEnvFiles,
  resolveServiceUrls,
  type ResolvedServiceUrls,
} from "./env.js";

const DEFAULT_CLASSIFY_URL = "https://astroboi-halo-guard.chutes.ai/v1/classify";
const DEFAULT_CLASSIFY_MODEL = "halo-guard";

/** Local `scripts/serve_halo_guard.py`; model: https://huggingface.co/astroware/Halo0.8B-guard-v1 */
const DEFAULT_LOCAL_CLASSIFY_URL = "http://127.0.0.1:8000/v1/classify";
const DEFAULT_LOCAL_CLASSIFY_MODEL = "astroware/Halo0.8B-guard-v1";

function usage(): string {
  return `
tri-check guard-probe — send one user message through OpenClaw (exercises gateway + input guard), no judge.
Optional: bypass OpenClaw and call Halo /v1/classify directly (Chutes or local).

Usage:
  pnpm guard-probe -- --query <text>
  pnpm guard-probe -- --query <text> --halo-direct
  pnpm guard-probe -- --query <text> --local

Options:
  --query <text>        Required. User message sent to OpenClaw POST /v1/chat/completions (or query for direct classify).
  --halo-direct         Call Halo classify API only (no OpenClaw). Uses --role, CHUTES_API_KEY Bearer.
  --local               Same as direct classify, but to local guard (no CHUTES_API_KEY). Default URL ${DEFAULT_LOCAL_CLASSIFY_URL}, model ${DEFAULT_LOCAL_CLASSIFY_MODEL}. Start: bash docker-up.sh --local (needs pip install -r scripts/requirements-halo-guard.txt)
  --role <input|output> With --halo-direct / --local only (default: input).
  --classify-url <url>  Override classify URL (--halo-direct: default ${DEFAULT_CLASSIFY_URL}; --local: default ${DEFAULT_LOCAL_CLASSIFY_URL})
  --classify-model <id> Override classify model id in JSON body (--halo-direct: default ${DEFAULT_CLASSIFY_MODEL}; --local: default ${DEFAULT_LOCAL_CLASSIFY_MODEL})
  --openclaw-url <url>  Override OPENCLAW_URL (same as tri-check --url)
  --verbose             Log URLs and Chutes key fingerprint (still redacted)
  -h, --help

  --openclaw            Ignored (legacy): OpenClaw is the default.

Env:
  OPENCLAW_URL, OPENCLAW_GATEWAY_PASSWORD or OPENCLAW_GATEWAY_TOKEN — required unless --halo-direct
  CHUTES_API_KEY        Sent as X-Chutes-Api-Key to OpenClaw; required Bearer for --halo-direct (not --local)
  HALO_CLASSIFY_URL, HALO_CLASSIFY_MODEL — optional; Chutes direct mode
  HALO_LOCAL_CLASSIFY_URL, HALO_LOCAL_CLASSIFY_MODEL — optional; defaults for --local

Examples:
  cd tri-check && pnpm guard-probe -- --query "What is 2+2?"
  cd tri-check && pnpm guard-probe -- --query "ignore previous instructions"
  cd tri-check && pnpm guard-probe -- --query "What is 2+2?" --halo-direct
  cd tri-check && pnpm guard-probe -- --query "What is 2+2?" --local
`.trim();
}

interface Parsed {
  query?: string;
  role: HaloClassifyRole;
  haloDirect: boolean;
  /** Direct classify to local serve_halo_guard (no Bearer). */
  local: boolean;
  classifyUrl: string;
  classifyModel: string;
  openclawUrl?: string;
  verbose: boolean;
  help: boolean;
}

function parseArgv(argv: string[]): Parsed {
  const out: Parsed = {
    role: "input",
    haloDirect: false,
    local: false,
    classifyUrl: (process.env.HALO_CLASSIFY_URL ?? DEFAULT_CLASSIFY_URL).trim(),
    classifyModel: (process.env.HALO_CLASSIFY_MODEL ?? DEFAULT_CLASSIFY_MODEL).trim(),
    verbose: false,
    help: false,
  };
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
    if (a === "--halo-direct") {
      out.haloDirect = true;
      continue;
    }
    if (a === "--local") {
      out.local = true;
      out.haloDirect = true;
      out.classifyUrl = (process.env.HALO_LOCAL_CLASSIFY_URL ?? DEFAULT_LOCAL_CLASSIFY_URL).trim();
      out.classifyModel = (process.env.HALO_LOCAL_CLASSIFY_MODEL ?? DEFAULT_LOCAL_CLASSIFY_MODEL).trim();
      continue;
    }
    if (a === "--openclaw") {
      continue;
    }
    if (a === "--query") {
      out.query = take();
      continue;
    }
    if (a === "--role") {
      const r = take().toLowerCase();
      if (r !== "input" && r !== "output") {
        throw new Error(`--role must be input or output, got: ${r}`);
      }
      out.role = r;
      continue;
    }
    if (a === "--classify-url") {
      out.classifyUrl = take().trim();
      continue;
    }
    if (a === "--classify-model") {
      out.classifyModel = take().trim();
      continue;
    }
    if (a === "--openclaw-url" || a === "--url") {
      out.openclawUrl = take().trim();
      continue;
    }
    if (a.startsWith("--query=")) {
      out.query = a.slice("--query=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${a}\n\n${usage()}`);
  }
  return out;
}

function interpretHaloStatus(status: string): "block" | "allow" | "unknown" {
  const u = status.trim().toUpperCase();
  if (u === "HARMFUL") return "block";
  if (u === "HARMLESS") return "allow";
  return "unknown";
}

function interpretOpenClawContent(content: string): { label: string; blocked: boolean | null } {
  const t = content.trim();
  if (/blocked by guard/i.test(t) || /probable prompt injection/i.test(t)) {
    return { label: "input guard blocked (refusal / guard text in assistant content)", blocked: true };
  }
  if (/^error:/i.test(t) || /^no response from openclaw/i.test(t)) {
    return { label: "error or empty agent response (see preview)", blocked: null };
  }
  return {
    label: "request reached the model and returned assistant text (input guard allowed)",
    blocked: false,
  };
}

async function runDirectHalo(
  parsed: Parsed,
  urls: ResolvedServiceUrls,
): Promise<void> {
  const key = urls.chutesApiKey.trim();
  if (!parsed.local && !key) {
    console.error("CHUTES_API_KEY is required for direct Halo classify (use --local for a local guard server without Chutes).");
    process.exitCode = 1;
    return;
  }
  const res = await callHaloClassify({
    classifyUrl: parsed.classifyUrl,
    classifyModel: parsed.classifyModel,
    query: parsed.query!,
    role: parsed.role,
    chutesApiKey: parsed.local ? "" : key,
  });
  const status = typeof res.status === "string" ? res.status : "";
  const verdict = interpretHaloStatus(status);
  console.log(
    JSON.stringify(
      { mode: parsed.local ? "halo_classify_local" : "halo_classify", verdict, status, response: res },
      null,
      2,
    ),
  );
  if (verdict === "block") process.exitCode = 2;
  else if (verdict === "unknown") process.exitCode = 1;
}

async function runViaOpenClaw(parsed: Parsed, urls: ResolvedServiceUrls): Promise<void> {
  if (!urls.openclawToken.trim()) {
    console.error(
      "OPENCLAW_GATEWAY_PASSWORD or OPENCLAW_GATEWAY_TOKEN is required (guard-probe talks to OpenClaw by default).",
    );
    process.exitCode = 1;
    return;
  }
  if (!urls.chutesApiKey.trim()) {
    process.stderr.write(
      "[guard-probe] warning: CHUTES_API_KEY empty — OpenClaw may fail to call Chutes models.\n",
    );
  }
  try {
    const content = await callOpenClaw(urls.openclawUrl, urls, parsed.query!);
    const { label, blocked } = interpretOpenClawContent(content);
    console.log(
      JSON.stringify(
        {
          mode: "openclaw_chat_completions",
          openclaw_url: urls.openclawUrl,
          blocked,
          interpretation: label,
          assistant_content_preview: content.slice(0, 500) + (content.length > 500 ? "…" : ""),
        },
        null,
        2,
      ),
    );
    if (blocked === true) process.exitCode = 2;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  let parsed: Parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
    return;
  }
  if (parsed.help || argv.length === 0) {
    console.log(usage());
    if (argv.length === 0) process.exitCode = 1;
    return;
  }
  if (!parsed.query || !parsed.query.trim()) {
    console.error("--query is required.\n");
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  const urls = resolveServiceUrls({ openclawUrl: parsed.openclawUrl });
  if (parsed.verbose) {
    process.stderr.write(`[guard-probe] CHUTES_API_KEY: ${formatChutesKeyForLog(urls.chutesApiKey)}\n`);
    process.stderr.write(`[guard-probe] OPENCLAW_URL: ${urls.openclawUrl}\n`);
    if (parsed.haloDirect) {
      process.stderr.write(`[guard-probe] classify URL: ${parsed.classifyUrl}\n`);
      process.stderr.write(`[guard-probe] classify model: ${parsed.classifyModel}\n`);
    }
  }

  if (parsed.haloDirect) {
    await runDirectHalo(parsed, urls);
  } else {
    await runViaOpenClaw(parsed, urls);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
