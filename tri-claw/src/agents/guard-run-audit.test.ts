import { describe, expect, it } from "vitest";
import {
  formatGuardRunAudit,
  recordGuardPhase,
  takeGuardRunAudit,
} from "./guard-run-audit.js";

describe("guard-run-audit", () => {
  it("records both phases and formats compact JSON", () => {
    const runId = `chatcmpl_audit_${Date.now()}`;
    recordGuardPhase(runId, "input", { ran: true, decision: "allow", reason: "general" });
    recordGuardPhase(runId, "output", {
      ran: true,
      decision: "block",
      reason: "unethical_acts",
    });

    const audit = takeGuardRunAudit(runId);
    expect(audit).toEqual({
      input: { ran: true, decision: "allow", reason: "general" },
      output: { ran: true, decision: "block", reason: "unethical_acts" },
    });
    expect(JSON.parse(formatGuardRunAudit(audit))).toEqual(audit);
    expect(takeGuardRunAudit(runId).input.skipped).toBe("not_recorded");
  });

  it("marks phases that were never recorded", () => {
    const audit = takeGuardRunAudit("missing-run");
    expect(audit.input).toEqual({ ran: false, skipped: "not_recorded" });
    expect(audit.output).toEqual({ ran: false, skipped: "not_recorded" });
  });
});
