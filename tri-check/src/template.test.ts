/**
 * Mirrors sn23-backend tests/test_prompt_template.py validation cases.
 * Keep the three implementations (Python backend, this file, alignet/cli/prompt_template.py)
 * checked against the same list — silent divergence causes "passed locally, rejected on upload".
 */
import { describe, expect, it } from "vitest";
import {
  PROMPT_MAX_LEN,
  TemplateValidationError,
  expandTemplate,
  extractTemplate,
  validateTemplate,
} from "./template.js";

function questions(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    question_id: `Q${i + 1}`,
    objective: `Objective number ${i + 1} with distinct wording.`,
  }));
}

describe("extractTemplate", () => {
  it("returns the prompt from a valid body", () => {
    expect(extractTemplate({ prompt: "a {{objective}} b" })).toBe("a {{objective}} b");
  });

  it("names the new format when given a legacy Q body", () => {
    expect(() => extractTemplate({ Q1: { prompt: "x" }, Q2: { prompt: "y" } })).toThrow(
      /universal template format/,
    );
    expect(() => extractTemplate({ Q1: { prompt: "x" }, Q2: { prompt: "y" } })).toThrow(/Q1\.\.Qn/);
  });

  it("rejects extra top-level keys", () => {
    expect(() => extractTemplate({ prompt: "{{objective}}", url: "http://x" })).toThrow(
      /unsupported top-level key\(s\) url/,
    );
  });

  it("rejects a non-string prompt", () => {
    expect(() => extractTemplate({ prompt: 123 })).toThrow(TemplateValidationError);
  });

  it("rejects a non-object body", () => {
    expect(() => extractTemplate(["prompt"])).toThrow(TemplateValidationError);
  });
});

describe("validateTemplate", () => {
  it("accepts tolerant spellings", () => {
    for (const spelling of ["{{objective}}", "{{ objective }}", "{{Objective}}"]) {
      expect(() => validateTemplate(`prefix ${spelling} suffix`)).not.toThrow();
    }
  });

  it("rejects zero placeholders with the measurability rationale", () => {
    expect(() => validateTemplate("no placeholder here")).toThrow(/exactly once \(found none\)/);
    expect(() => validateTemplate("no placeholder here")).toThrow(/distinct trial/);
  });

  it("reports the count when there are two placeholders", () => {
    expect(() => validateTemplate("{{objective}} and {{objective}}")).toThrow(/\(found 2\)/);
  });

  it("names a foreign placeholder", () => {
    expect(() => validateTemplate("{{topic}} {{objective}}")).toThrow(
      /unsupported placeholder \{\{topic\}\}/,
    );
  });

  it("treats single braces as literal (count is zero)", () => {
    expect(() => validateTemplate("a {objective} b")).toThrow(/found none/);
  });

  it("rejects empty and whitespace", () => {
    for (const value of ["", "   ", "\n\t"]) {
      expect(() => validateTemplate(value)).toThrow("prompt must be a non-empty string");
    }
  });

  it("reports actual length when over the cap", () => {
    const tooLong = "x".repeat(PROMPT_MAX_LEN + 1) + "{{objective}}";
    expect(() => validateTemplate(tooLong)).toThrow(
      new RegExp(`maximum length ${PROMPT_MAX_LEN} characters`),
    );
    expect(() => validateTemplate(tooLong)).toThrow(new RegExp(`\\(got ${tooLong.length}\\)`));
  });
});

describe("expandTemplate", () => {
  // The question count is per-challenge, so nothing here may assume one.
  // 1 is the degenerate floor, 6 the current target, 12 what production ran before.
  const COUNTS = [1, 6, 12];

  it.each(COUNTS)("puts each question's own objective into the expansion (n=%i)", (n) => {
    const qs = questions(n);
    const out = expandTemplate("BEGIN {{objective}} END", qs);
    expect(Object.keys(out)).toHaveLength(n);
    for (const q of qs) {
      const prompt = out[q.question_id].prompt;
      expect(prompt).toContain(q.objective);
      expect(prompt).not.toContain("{{");
    }
  });

  it.each(COUNTS)("produces distinct expansions (n=%i)", (n) => {
    const out = expandTemplate("{{objective}}", questions(n));
    expect(new Set(Object.values(out).map((v) => v.prompt)).size).toBe(n);
  });
});
