/**
 * Question-id selection must follow the rubric, not whatever fixture file is
 * loaded alongside it.
 *
 * The rubric (data/questions.json) is hand-authored per challenge and its length
 * changes. Fixtures generated against an older, longer rubric outlive it. Before
 * rubricQuestionIds existed, judge-battery took its ids from the canned answers
 * file, so trimming the rubric left the battery calling the judge for questions
 * the rubric no longer defined -- with empty expected-output text, which the
 * judge happily scores as safe. Silent, and it looks like a passing run.
 */
import { describe, expect, it } from "vitest";
import { rubricQuestionIds, sortQuestionIds } from "./io.js";

function questions(count: number, start = 1) {
  return Array.from({ length: count }, (_, i) => ({
    question_id: `Q${start + i}`,
    objective: `Objective ${start + i}`,
  }));
}

describe("sortQuestionIds", () => {
  it("orders numerically, so Q2 precedes Q10", () => {
    expect(sortQuestionIds(["Q10", "Q2", "Q1"])).toEqual(["Q1", "Q2", "Q10"]);
  });

  it("falls back to lexicographic for non-numeric ids", () => {
    expect(sortQuestionIds(["beta", "alpha"])).toEqual(["alpha", "beta"]);
  });
});

describe("rubricQuestionIds", () => {
  it.each([1, 6, 12])("returns every rubric id in order (n=%i)", (n) => {
    const ids = rubricQuestionIds(questions(n));
    expect(ids).toHaveLength(n);
    expect(ids).toEqual(Array.from({ length: n }, (_, i) => `Q${i + 1}`));
  });

  it("ignores fixture entries the rubric no longer defines", () => {
    // The 12 -> 6 case: rubric trimmed, canned battery still carries Q1..Q12.
    const canned = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`Q${i + 1}`, `canned ${i + 1}`]),
    );
    expect(rubricQuestionIds(questions(6), canned)).toEqual([
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Q5",
      "Q6",
    ]);
  });

  it("skips rubric ids that have no fixture entry", () => {
    // The other direction: rubric grew, fixtures lag. Better to evaluate the
    // overlap than to crash or to judge against undefined text.
    const canned = { Q1: "a", Q2: "b" };
    expect(rubricQuestionIds(questions(6), canned)).toEqual(["Q1", "Q2"]);
  });

  it("returns nothing when the two sets do not overlap at all", () => {
    const canned = { Q7: "a", Q8: "b" };
    expect(rubricQuestionIds(questions(6), canned)).toEqual([]);
  });
});
