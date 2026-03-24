#!/usr/bin/env node
/**
 * Ping Chutes chat/completions for each model in tri-claw/docker/openclaw.lean.json
 * (primary + fallbacks). Requires CHUTES_API_KEY.
 *
 *   export CHUTES_API_KEY="..."
 *   node scripts/chutes-openclaw-smoke.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadChutesKeyFromFile(filePath) {
  if (!existsSync(filePath)) return false;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m =
      t.match(/^CHUTES_API_KEY=(.*)$/) || t.match(/^OPENCLAW_CHUTES_TOKEN=(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env.CHUTES_API_KEY = process.env.CHUTES_API_KEY || v;
    return true;
  }
  return false;
}

if (!process.env.CHUTES_API_KEY?.trim()) {
  loadChutesKeyFromFile(resolve(root, ".env")) ||
    loadChutesKeyFromFile(resolve(root, ".env.tri-claw"));
}

const apiKey = (
  process.env.CHUTES_API_KEY ||
  process.env.OPENCLAW_CHUTES_TOKEN ||
  ""
).trim();
if (!apiKey) {
  console.error(
    "chutes-openclaw-smoke: set CHUTES_API_KEY or OPENCLAW_CHUTES_TOKEN (e.g. in .env or .env.tri-claw)",
  );
  process.exit(2);
}

const leanPath = resolve(root, "tri-claw/docker/openclaw.lean.json");
if (!existsSync(leanPath)) {
  console.error("chutes-openclaw-smoke: missing", leanPath);
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(leanPath, "utf8"));
const baseUrl = (cfg.models?.providers?.chutes?.baseUrl ?? "").replace(/\/+$/, "");
const modelBlock = cfg.agents?.defaults?.model;
if (!baseUrl || !modelBlock?.primary) {
  console.error("chutes-openclaw-smoke: invalid openclaw.lean.json (chutes baseUrl / model.primary)");
  process.exit(1);
}

function stripChutes(ref) {
  return String(ref ?? "").replace(/^chutes\//, "");
}

const chain = [
  stripChutes(modelBlock.primary),
  ...(Array.isArray(modelBlock.fallbacks) ? modelBlock.fallbacks.map(stripChutes) : []),
].filter(Boolean);

const url = `${baseUrl}/chat/completions`;

console.log("chutes-openclaw-smoke: baseURL =", baseUrl);
console.log("chutes-openclaw-smoke: chain =", chain.join(" -> "));
console.log("");

let failed = false;
for (const model of chain) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
  });
  const text = (await res.text()).slice(0, 180).replace(/\s+/g, " ");
  console.log(`  model=${model} -> HTTP ${res.status}`, res.status !== 200 ? `| ${text}` : "");
  if (res.status !== 200) failed = true;
}

if (failed) {
  console.error("\nchutes-openclaw-smoke: one or more models failed (check IDs / key / access).");
  process.exit(1);
}

console.log("\nchutes-openclaw-smoke: all models returned HTTP 200.");
