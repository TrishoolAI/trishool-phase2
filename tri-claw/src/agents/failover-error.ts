import { classifyFailoverReason, type FailoverReason } from "./pi-embedded-helpers.js";

const TIMEOUT_HINT_RE =
  /timeout|timed out|deadline exceeded|context deadline exceeded|stop reason:\s*abort|reason:\s*abort|unhandled stop reason:\s*abort/i;
const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;

/** Matches "HTTP 502", "http 503", etc. anywhere in the message (not only at start). */
const HTTP_TOKEN_STATUS_RE = /\bhttps?\s+(\d{3})\b/gi;

const TRANSIENT_HTTP_STATUSES = new Set([
  500, 502, 503, 504, 521, 522, 523, 524, 529,
]);

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      status?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.status = params.status;
    this.code = params.code;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

export function resolveFailoverStatus(reason: FailoverReason): number | undefined {
  switch (reason) {
    case "billing":
      return 402;
    case "rate_limit":
      return 429;
    case "auth":
      return 401;
    case "timeout":
      return 408;
    case "format":
      return 400;
    case "model_not_found":
      return 404;
    default:
      return undefined;
  }
}

function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number") {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function getStatusCodeDeep(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== "object" || depth > 8) {
    return undefined;
  }
  const direct = getStatusCode(err);
  if (direct !== undefined) {
    return direct;
  }
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return getStatusCodeDeep(cause, depth + 1);
}

function accumulateErrorText(err: unknown, depth = 0): string {
  if (!err || depth > 8) {
    return "";
  }
  const parts: string[] = [];
  const msg = getErrorMessage(err);
  if (msg) {
    parts.push(msg);
  }
  if (err && typeof err === "object" && "cause" in err) {
    const nested = accumulateErrorText((err as { cause?: unknown }).cause, depth + 1);
    if (nested) {
      parts.push(nested);
    }
  }
  return parts.join("\n");
}

function mapHttpStatusToFailoverReason(
  status: number,
  opts?: { modelNotFoundFrom404?: boolean },
): FailoverReason | null {
  if (status === 402) {
    return "billing";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408) {
    return "timeout";
  }
  if (TRANSIENT_HTTP_STATUSES.has(status)) {
    return "timeout";
  }
  if (status === 400) {
    return "format";
  }
  if (opts?.modelNotFoundFrom404 && status === 404) {
    return "model_not_found";
  }
  return null;
}

/**
 * First "http(s) NNN" token in the text that maps to a failover reason (left-to-right).
 */
function extractFailoverHttpStatusFromText(text: string): {
  status: number;
  reason: FailoverReason;
} | null {
  if (!text) {
    return null;
  }
  HTTP_TOKEN_STATUS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTTP_TOKEN_STATUS_RE.exec(text)) !== null) {
    const code = Number(match[1]);
    if (!Number.isFinite(code)) {
      continue;
    }
    const reason = mapHttpStatusToFailoverReason(code, { modelNotFoundFrom404: true });
    if (reason) {
      return { status: code, reason };
    }
  }
  return null;
}

function getErrorName(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  return "name" in err ? String(err.name) : "";
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = (err as { code?: unknown }).code;
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  return trimmed ? trimmed : undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.description ?? "";
  }
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function hasTimeoutHint(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (getErrorName(err) === "TimeoutError") {
    return true;
  }
  const message = getErrorMessage(err);
  return Boolean(message && TIMEOUT_HINT_RE.test(message));
}

export function isTimeoutError(err: unknown): boolean {
  if (hasTimeoutHint(err)) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  if (getErrorName(err) !== "AbortError") {
    return false;
  }
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) {
    return true;
  }
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  const reason = "reason" in err ? (err as { reason?: unknown }).reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

export function resolveFailoverReasonFromError(err: unknown): FailoverReason | null {
  if (isFailoverError(err)) {
    return err.reason;
  }

  const status = getStatusCodeDeep(err);
  if (status !== undefined) {
    const fromStatus = mapHttpStatusToFailoverReason(status);
    if (fromStatus) {
      return fromStatus;
    }
  }

  const code = (getErrorCode(err) ?? "").toUpperCase();
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNABORTED"].includes(code)) {
    return "timeout";
  }
  if (isTimeoutError(err)) {
    return "timeout";
  }

  const combined = accumulateErrorText(err);
  const fromHttpToken = extractFailoverHttpStatusFromText(combined);
  if (fromHttpToken) {
    return fromHttpToken.reason;
  }

  if (!combined) {
    return null;
  }
  return classifyFailoverReason(combined);
}

export function describeFailoverError(err: unknown): {
  message: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
} {
  if (isFailoverError(err)) {
    return {
      message: err.message,
      reason: err.reason,
      status: err.status,
      code: err.code,
    };
  }
  const message = getErrorMessage(err) || String(err);
  const inferred = extractFailoverHttpStatusFromText(accumulateErrorText(err));
  return {
    message,
    reason: resolveFailoverReasonFromError(err) ?? undefined,
    status: getStatusCodeDeep(err) ?? inferred?.status,
    code: getErrorCode(err),
  };
}

export function coerceToFailoverError(
  err: unknown,
  context?: {
    provider?: string;
    model?: string;
    profileId?: string;
  },
): FailoverError | null {
  if (isFailoverError(err)) {
    return err;
  }
  const reason = resolveFailoverReasonFromError(err);
  if (!reason) {
    return null;
  }

  const message = getErrorMessage(err) || String(err);
  const inferred = extractFailoverHttpStatusFromText(accumulateErrorText(err));
  const status = getStatusCodeDeep(err) ?? inferred?.status ?? resolveFailoverStatus(reason);
  const code = getErrorCode(err);

  return new FailoverError(message, {
    reason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    cause: err instanceof Error ? err : undefined,
  });
}
