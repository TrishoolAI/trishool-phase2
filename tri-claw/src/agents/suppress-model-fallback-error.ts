/**
 * Errors that must not trigger the agent model fallback chain (e.g. guard/judge
 * evaluation failures where switching models would hide an operational problem).
 */
export class SuppressModelFallbackError extends Error {
  override readonly name = "SuppressModelFallbackError";
}

export function isSuppressModelFallbackError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 12; depth += 1) {
    if (current instanceof SuppressModelFallbackError) {
      return true;
    }
    if (!current || typeof current !== "object" || !("cause" in current)) {
      return false;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
