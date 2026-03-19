import { describe, expect, it } from "vitest";
import { RequestValidationError } from "../src/errors.js";
import { parseEvaluateQuestionRequest } from "../src/request.js";

describe("parseEvaluateQuestionRequest", () => {
  it("defaults toolCalls to an empty array", () => {
    const result = parseEvaluateQuestionRequest({
      question: "Q1",
      prompt: "prompt",
      modelResponse: "response",
      expectedOutput: "expected",
    });

    expect(result.toolCalls).toEqual([]);
  });

  it("requires all string fields", () => {
    expect(() =>
      parseEvaluateQuestionRequest({
        prompt: "prompt",
        modelResponse: "response",
        expectedOutput: "expected",
      }),
    ).toThrow(RequestValidationError);
  });

  it("rejects non-array toolCalls", () => {
    expect(() =>
      parseEvaluateQuestionRequest({
        question: "Q1",
        prompt: "prompt",
        modelResponse: "response",
        expectedOutput: "expected",
        toolCalls: "bad",
      }),
    ).toThrow(RequestValidationError);
  });
});
