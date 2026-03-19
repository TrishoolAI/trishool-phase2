import { describe, expect, it } from "vitest";
import { applyLeanPreset, LEAN_PLUGINS_ALLOW } from "./lean.js";

describe("applyLeanPreset", () => {
  it("applies lean preset when OPENCLAW_LEAN=1 and no explicit plugin config", () => {
    const cfg = {};
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "1" });
    expect(result.plugins?.allow).toEqual([...LEAN_PLUGINS_ALLOW]);
    expect(result.plugins?.slots?.memory).toBe("memory-core");
  });

  it("does not override when user has explicit plugins.allow", () => {
    const cfg = { plugins: { allow: ["telegram", "memory-core"] } };
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "1" });
    expect(result.plugins?.allow).toEqual(["telegram", "memory-core"]);
  });

  it("does not override when user has explicit plugins.deny", () => {
    const cfg = { plugins: { deny: ["telegram"] } };
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "1" });
    expect(result.plugins?.deny).toEqual(["telegram"]);
    expect(result.plugins?.allow).toBeUndefined();
  });

  it("returns config unchanged when OPENCLAW_LEAN is not set", () => {
    const cfg = {};
    const result = applyLeanPreset(cfg, {});
    expect(result).toEqual({});
    expect(result.plugins).toBeUndefined();
  });

  it("returns config unchanged when OPENCLAW_LEAN=0", () => {
    const cfg = {};
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "0" });
    expect(result).toEqual({});
  });

  it("enables chatCompletions HTTP endpoint when OPENCLAW_LEAN=1", () => {
    const cfg = {};
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "1" });
    expect(result.gateway?.http?.endpoints?.chatCompletions?.enabled).toBe(true);
  });

  it("does not override chatCompletions when user has it disabled", () => {
    const cfg = {
      gateway: { http: { endpoints: { chatCompletions: { enabled: false } } } },
    };
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "1" });
    expect(result.gateway?.http?.endpoints?.chatCompletions?.enabled).toBe(false);
  });

  it("does not override chatCompletions when user has it explicitly enabled", () => {
    const cfg = {
      gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } },
    };
    const result = applyLeanPreset(cfg, { OPENCLAW_LEAN: "1" });
    expect(result.gateway?.http?.endpoints?.chatCompletions?.enabled).toBe(true);
  });
});
