export class ConfigError extends Error {}

export class RequestValidationError extends Error {}

export class JudgeUpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    /** Truncated upstream (e.g. Chutes) response body for debugging; may be empty. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export class JudgeOutputError extends Error {
  constructor(message: string) {
    super(message);
  }
}
