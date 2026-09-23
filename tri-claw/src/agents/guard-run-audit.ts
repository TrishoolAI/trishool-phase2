/**
 * Per-run record of input/output guard decisions.
 * The OpenAI HTTP handler copies this into `deobfuscatedPrompt` so validators
 * can forward it on the existing judge field without a new platform column.
 */

export type GuardPhaseAudit = {
  ran: boolean;
  decision?: "allow" | "block" | "error";
  reason?: string;
  /** Present when the classifier returned a numeric score. */
  probability?: number;
  probabilityCalibrated?: number;
  skipped?: string;
};

export type GuardRunAudit = {
  input: GuardPhaseAudit;
  output: GuardPhaseAudit;
};

const MAX_RUNS = 200;

type AuditStore = Map<string, { input?: GuardPhaseAudit; output?: GuardPhaseAudit }>;

/**
 * The gateway loads this file from compiled `dist/`, while the guard plugin loads
 * the same source through jiti. A module-level Map would be two separate stores.
 */
function auditStore(): AuditStore {
  const g = globalThis as typeof globalThis & { __openclawGuardRunAudit?: AuditStore };
  if (!g.__openclawGuardRunAudit) {
    g.__openclawGuardRunAudit = new Map();
  }
  return g.__openclawGuardRunAudit;
}

function remember(runId: string): { input?: GuardPhaseAudit; output?: GuardPhaseAudit } {
  const runs = auditStore();
  const existing = runs.get(runId);
  if (existing) {
    return existing;
  }
  if (runs.size >= MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest) {
      runs.delete(oldest);
    }
  }
  const created: { input?: GuardPhaseAudit; output?: GuardPhaseAudit } = {};
  runs.set(runId, created);
  return created;
}

export function recordGuardPhase(
  runId: string | undefined,
  phase: "input" | "output",
  audit: GuardPhaseAudit,
): void {
  const id = runId?.trim();
  if (!id) {
    return;
  }
  remember(id)[phase] = audit;
}

/** Read and drop the audit for this run. Missing phases mean the guard never recorded them. */
export function takeGuardRunAudit(runId: string | undefined): GuardRunAudit {
  const id = runId?.trim() ?? "";
  const runs = auditStore();
  const partial = id ? runs.get(id) : undefined;
  if (id) {
    runs.delete(id);
  }
  return {
    input: partial?.input ?? { ran: false, skipped: "not_recorded" },
    output: partial?.output ?? { ran: false, skipped: "not_recorded" },
  };
}

export function formatGuardRunAudit(audit: GuardRunAudit): string {
  return JSON.stringify(audit);
}
