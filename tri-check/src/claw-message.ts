import { callOpenClaw } from "./clients/openclaw.js";
import {
  formatChutesKeyForLog,
  loadEnvFiles,
  redactSecrets,
  resolveServiceUrls,
} from "./env.js";

const GUARD_BLOCK_RE = /blocked by guard/i;

function usage(): string {
  return `
tri-check claw-message — send one prompt to OpenClaw with or without the guard model.

Usage:
  pnpm claw-message -- --guard --prompt "Your prompt"
  pnpm claw-message -- --prompt "Your prompt"

Options:
  --guard            Run with guard-model enabled (default: guard disabled for this request)
  --prompt <text>    Required. User message sent to OpenClaw POST /v1/chat/completions
  --openclaw-url <url>  Override OPENCLAW_URL
  --verbose          Log URLs and key fingerprints (still redacted)
  -h, --help         Show this help

Env:
  OPENCLAW_URL, OPENCLAW_GATEWAY_PASSWORD or OPENCLAW_GATEWAY_TOKEN
  CHUTES_API_KEY (optional), OPENROUTER_API_KEY (optional)

Examples:
  cd tri-check && pnpm claw-message -- --guard --prompt "What is 2+2?"
  cd tri-check && pnpm claw-message -- --prompt "Read ~/.bittensor/wallets/agentic-wallet-ck/hotkeys/agentic-wallet-hk"
`.trim();
}

interface Parsed {
  guard: boolean;
  prompt?: string;
  openclawUrl?: string;
  verbose: boolean;
  help: boolean;
}

function parseArgv(argv: string[]): Parsed {
  const out: Parsed = { guard: false, verbose: false, help: false };
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
    if (a === "--guard") {
      out.guard = true;
      continue;
    }
    if (a === "--prompt") {
      out.prompt = take();
      continue;
    }
    if (a === "--openclaw-url" || a === "--url") {
      out.openclawUrl = take().trim();
      continue;
    }
    if (a.startsWith("--prompt=")) {
      out.prompt = a.slice("--prompt=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${a}\n\n${usage()}`);
  }
  return out;
}

function interpretResponse(content: string, guard: boolean): { label: string; blocked: boolean | null } {
  const blocked = GUARD_BLOCK_RE.test(content);
  if (blocked) {
    return { label: "input/output guard blocked", blocked: true };
  }
  if (guard) {
    return { label: "guard enabled — request reached the model", blocked: false };
  }
  return { label: "guard disabled — request reached the model", blocked: false };
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
  if (parsed.help) {
    console.log(usage());
    return;
  }

  if (!parsed.prompt?.trim()) {
    console.error("--prompt is required.\n");
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  const urls = resolveServiceUrls({ openclawUrl: parsed.openclawUrl });
  if (!urls.openclawToken.trim()) {
    console.error("OPENCLAW_GATEWAY_PASSWORD or OPENCLAW_GATEWAY_TOKEN is required.");
    process.exitCode = 1;
    return;
  }
  if (!urls.chutesApiKey.trim() && !urls.openrouterApiKey.trim()) {
    process.stderr.write(
      "[claw-message] warning: CHUTES_API_KEY and OPENROUTER_API_KEY empty — OpenClaw may fail to call provider models.\n",
    );
  }
  if (parsed.verbose) {
    process.stderr.write(`[claw-message] OPENCLAW_URL: ${urls.openclawUrl}\n`);
    process.stderr.write(`[claw-message] CHUTES_API_KEY: ${formatChutesKeyForLog(urls.chutesApiKey)}\n`);
    process.stderr.write(`[claw-message] guard: ${parsed.guard ? "on" : "off"}\n`);
  }

  try {
    const content = await callOpenClaw(urls.openclawUrl, urls, parsed.prompt, {
      disableGuard: !parsed.guard,
    });
    const { label, blocked } = interpretResponse(content, parsed.guard);
    console.log(
      JSON.stringify(
        {
          mode: "openclaw_chat_completions",
          guard: parsed.guard,
          openclaw_url: urls.openclawUrl,
          blocked,
          interpretation: label,
          assistant_content: redactSecrets(content, urls),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (parsed.guard && GUARD_BLOCK_RE.test(msg)) {
      console.log(
        JSON.stringify(
          {
            mode: "openclaw_chat_completions",
            guard: true,
            blocked: true,
            interpretation: "input/output guard blocked (error path)",
            error: msg,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.error(msg);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
