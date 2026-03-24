#!/usr/bin/env node
/**
 * Diagnostic: test whether Chutes models support OpenAI-style function calling.
 * Sends a simple prompt with a tool definition and checks whether the model
 * returns structured `tool_calls` or just plain text.
 *
 *   export CHUTES_API_KEY="..."
 *   node scripts/chutes-tool-call-diag.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadKey(filePath) {
  if (!existsSync(filePath)) return false;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^CHUTES_API_KEY=(.*)$/) || t.match(/^OPENCLAW_CHUTES_TOKEN=(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    process.env.CHUTES_API_KEY = process.env.CHUTES_API_KEY || v;
    return true;
  }
  return false;
}

if (!process.env.CHUTES_API_KEY?.trim()) {
  loadKey(resolve(root, ".env")) || loadKey(resolve(root, ".env.tri-claw"));
}

const apiKey = (process.env.CHUTES_API_KEY || process.env.OPENCLAW_CHUTES_TOKEN || "").trim();
if (!apiKey) {
  console.error("Set CHUTES_API_KEY or OPENCLAW_CHUTES_TOKEN");
  process.exit(2);
}

const BASE_URL = "https://llm.chutes.ai/v1/chat/completions";

const TOOL_DEF = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write content to a file at the given path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
};

const MODELS = [
  "Qwen/Qwen3-32B-TEE",
  "chutesai/Mistral-Small-3.1-24B-Instruct-2503-TEE",
  "unsloth/gemma-3-27b-it",
];

const PROMPT = 'Use the write_file tool to create a file at "test.txt" with content "hello world". You MUST call the tool, do not describe the call in text.';

async function testModel(model) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`MODEL: ${model}`);
  console.log("=".repeat(70));

  // Test 1: with tools + tool_choice auto
  for (const toolChoice of ["auto", "required", undefined]) {
    const label = toolChoice ? `tool_choice="${toolChoice}"` : "no tool_choice";
    console.log(`\n--- ${label} ---`);

    const body = {
      model,
      messages: [{ role: "user", content: PROMPT }],
      tools: [TOOL_DEF],
      max_tokens: 512,
      temperature: 0,
      stream: false,
    };
    if (toolChoice) body.tool_choice = toolChoice;

    try {
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.log(`  HTTP ${res.status}: ${errText.slice(0, 300)}`);
        continue;
      }

      const json = await res.json();
      const choice = json.choices?.[0];
      if (!choice) {
        console.log("  No choices in response:", JSON.stringify(json).slice(0, 300));
        continue;
      }

      const hasToolCalls = !!(choice.message?.tool_calls?.length);
      const hasTextContent = !!(choice.message?.content?.trim());
      const finishReason = choice.finish_reason;

      console.log(`  finish_reason: ${finishReason}`);
      console.log(`  has tool_calls: ${hasToolCalls}`);
      console.log(`  has text content: ${hasTextContent}`);

      if (hasToolCalls) {
        console.log(`  TOOL CALLS:`);
        for (const tc of choice.message.tool_calls) {
          console.log(`    - ${tc.function?.name}(${tc.function?.arguments})`);
        }
      }

      if (hasTextContent) {
        const text = choice.message.content.slice(0, 400);
        console.log(`  TEXT: ${text}`);
      }

      if (hasToolCalls && finishReason === "tool_calls") {
        console.log(`  >>> TOOL CALLING WORKS for ${model} with ${label}`);
      } else if (hasToolCalls) {
        console.log(`  >>> TOOL CALLS present but finish_reason=${finishReason} (partial support)`);
      } else {
        console.log(`  >>> NO TOOL CALLS — model replied in plain text only`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  // Test 2: without tools (control)
  console.log(`\n--- no tools (control) ---`);
  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
    });
    const text = await res.text();
    console.log(`  HTTP ${res.status}: ${text.slice(0, 200)}`);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}

console.log("Chutes Tool-Call Diagnostic");
console.log(`Testing ${MODELS.length} models for function calling support...\n`);

for (const m of MODELS) {
  await testModel(m);
}

console.log("\n\nDone.");
