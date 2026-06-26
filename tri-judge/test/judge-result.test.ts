import { describe, expect, it } from "vitest";
import {
  isTrivialJudgeText,
  malformedJudgeResponse,
  validateJudgeResponse,
} from "../src/judge-result.js";

describe("isTrivialJudgeText", () => {
  it("detects ellipsis-only placeholders", () => {
    expect(isTrivialJudgeText("...")).toBe(true);
    expect(isTrivialJudgeText("…")).toBe(true);
    expect(isTrivialJudgeText(" . … ")).toBe(true);
    expect(isTrivialJudgeText("n/a")).toBe(true);
  });

  it("allows real analysis", () => {
    expect(isTrivialJudgeText("The model refused and cited policy.")).toBe(false);
  });
});

describe("validateJudgeResponse", () => {
  it("replaces placeholder-only deobfuscatedPrompt and judgeReasoning", () => {
    const out = validateJudgeResponse(
      {
        prompt: "",
        deobfuscatedPrompt: "...",
        modelResponse: "",
        judgeReasoning: "...",
        judgeVerdict: "safe",
        score: 0,
        toolCalls: [],
      },
      { prompt: "user asks for harm", modelResponse: "harmful reply" },
    );
    expect(out.deobfuscatedPrompt).not.toBe("...");
    expect(out.deobfuscatedPrompt).toContain("placeholder");
    expect(out.judgeReasoning).not.toBe("...");
    expect(out.judgeReasoning).toContain("placeholder");
    expect(out.judgeReasoning).toContain("safe");
  });

  it("returns full prompt and modelResponse from originalContext when judge echoes truncated text", () => {
    const longPrompt = `${"p".repeat(400)}END_PROMPT`;
    const longResponse = `${"m".repeat(400)}END_RESPONSE`;
    const payload = {
      prompt: `${longPrompt.slice(0, 200)}...`,
      deobfuscatedPrompt: "restated intent",
      modelResponse: `${longResponse.slice(0, 200)}...`,
      toolCalls: [] as unknown[],
      judgeReasoning: "Compliant refusal.",
      judgeVerdict: "safe",
      score: 0,
    };

    const out = validateJudgeResponse(payload, {
      prompt: longPrompt,
      modelResponse: longResponse,
    });

    expect(out.prompt).toBe(longPrompt);
    expect(out.modelResponse).toBe(longResponse);
    expect(out.prompt.endsWith("END_PROMPT")).toBe(true);
    expect(out.modelResponse.endsWith("END_RESPONSE")).toBe(true);
  });

  it("returns full strings when judge sends empty echoes and originalContext is provided", () => {
    const prompt = "full user prompt";
    const modelResponse = "full assistant text";
    const payload = {
      prompt: "",
      deobfuscatedPrompt: "x",
      modelResponse: "",
      toolCalls: [],
      judgeReasoning: "ok",
      judgeVerdict: "safe",
      score: 0,
    };

    const out = validateJudgeResponse(payload, {
      prompt,
      modelResponse,
    });

    expect(out.prompt).toBe(prompt);
    expect(out.modelResponse).toBe(modelResponse);
  });

  it("returns malformed safe shape when payload is not a JSON object", () => {
    const out = validateJudgeResponse(["not", "an", "object"]);
    expect(out.judgeVerdict).toBe("safe");
    expect(out.score).toBe(0);
    expect(out.deobfuscatedPrompt).toBe("error");
    expect(out.prompt).toBe("");
    expect(out.modelResponse).toBe("");
    expect(out.judgeReasoning).toMatch(/Malformed JSON in judge response/);
  });

  it("malformedJudgeResponse matches API contract for errors", () => {
    const out = malformedJudgeResponse('{bad', "invalid JSON");
    expect(out).toEqual({
      prompt: "",
      deobfuscatedPrompt: "error",
      modelResponse: "",
      toolCalls: [],
      judgeReasoning: expect.stringMatching(/^Malformed JSON in judge response \(invalid JSON\)\. JSON value:/),
      judgeVerdict: "safe",
      score: 0,
    });
  });

  it("falls back to judge payload when originalContext is omitted", () => {
    const payload = {
      prompt: "only-from-judge",
      deobfuscatedPrompt: "",
      modelResponse: "response-from-judge",
      toolCalls: [],
      judgeReasoning: "ok",
      judgeVerdict: "safe",
      score: 0,
    };

    const out = validateJudgeResponse(payload);

    expect(out.prompt).toBe("only-from-judge");
    expect(out.modelResponse).toBe("response-from-judge");
  });
});
