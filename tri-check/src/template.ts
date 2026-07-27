/**
 * Universal jailbreak template: validation and local expansion.
 *
 * Rules and every error string here are mirrored in two other places and must
 * stay byte-identical:
 *
 *   - app/core/prompt_template.py   (sn23-backend, authoritative on upload)
 *   - alignet/cli/miner.py          (miner CLI pre-flight)
 *
 * Divergence between the three is what produces "it passed locally but the
 * upload was rejected", so change all three together or none.
 */

export const PROMPT_MAX_LEN = 2000;

/** Case- and whitespace-tolerant: {{objective}}, {{ objective }}, {{Objective}}. */
export const PLACEHOLDER_RE = /\{\{\s*objective\s*\}\}/gi;

/** Any {{...}} at all, used to reject unsupported placeholders. */
export const ANY_PLACEHOLDER_RE = /\{\{(.*?)\}\}/gs;

export class TemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

export function isTemplateSubmission(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as Record<string, unknown>).prompt === "string" &&
    !Object.keys(body as object).some((k) => /^[Qq]\d+$/.test(k))
  );
}

export function extractTemplate(submissionItems: unknown): string {
  if (typeof submissionItems !== "object" || submissionItems === null || Array.isArray(submissionItems)) {
    throw new TemplateValidationError("Submission items must be a JSON object");
  }

  const body = submissionItems as Record<string, unknown>;
  const keys = Object.keys(body);

  if (keys.length === 0) {
    throw new TemplateValidationError(
      'Submission items must be a JSON object of the form {"prompt": "<text>"}',
    );
  }

  if (!("prompt" in body) && keys.some((k) => /^[Qq]\d+$/.test(k))) {
    throw new TemplateValidationError(
      'This challenge expects the universal template format {"prompt": "... {{objective}} ..."}, not per-question Q1..Qn items. See docs/universal-jailbreaks.md',
    );
  }

  const extra = keys.filter((k) => k !== "prompt").sort();
  if (extra.length > 0) {
    throw new TemplateValidationError(
      `unsupported top-level key(s) ${extra.join(", ")} — the template body must contain only "prompt"`,
    );
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string") {
    throw new TemplateValidationError("prompt must be a non-empty string");
  }
  return prompt;
}

export function validateTemplate(template: string, maxLen: number = PROMPT_MAX_LEN): void {
  if (typeof template !== "string" || !template.trim()) {
    throw new TemplateValidationError("prompt must be a non-empty string");
  }

  if (template.length > maxLen) {
    throw new TemplateValidationError(
      `prompt exceeds maximum length ${maxLen} characters (got ${template.length})`,
    );
  }

  for (const match of template.matchAll(ANY_PLACEHOLDER_RE)) {
    const full = match[0];
    const anchored = /^\{\{\s*objective\s*\}\}$/i;
    if (!anchored.test(full)) {
      throw new TemplateValidationError(
        `unsupported placeholder ${full} — only {{objective}} is allowed (single braces are literal text)`,
      );
    }
  }

  const found = [...template.matchAll(/\{\{\s*objective\s*\}\}/gi)].length;
  if (found === 0) {
    throw new TemplateValidationError(
      "template must contain the {{objective}} placeholder exactly once (found none) — the placeholder is required so that each question is a distinct trial, even if your technique does not depend on the objective text",
    );
  }
  if (found > 1) {
    throw new TemplateValidationError(
      `template must contain the {{objective}} placeholder exactly once (found ${found})`,
    );
  }
}

export type QuestionLike = {
  question_id?: string;
  objective?: string;
};

/**
 * Substitute each question's objective into the template.
 * Only the submitted template is length-capped (PROMPT_MAX_LEN including {{objective}}).
 */
export function expandTemplate(
  template: string,
  questions: QuestionLike[],
): Record<string, { prompt: string }> {
  if (!questions.length) {
    throw new TemplateValidationError("Active challenge has no questions configured");
  }

  const expanded: Record<string, { prompt: string }> = {};
  for (const question of questions) {
    const questionId = question.question_id;
    if (typeof questionId !== "string" || !questionId) {
      throw new TemplateValidationError("Active challenge has a question with no question_id");
    }
    const objective = question.objective;
    if (typeof objective !== "string" || !objective.trim()) {
      throw new TemplateValidationError(
        `Active challenge question ${questionId} has no objective text`,
      );
    }
    // Single non-global replace (no `g` flag) — a second slot was already rejected.
    const prompt = template.replace(/\{\{\s*objective\s*\}\}/i, () => objective);
    expanded[questionId] = { prompt };
  }
  return expanded;
}
