import { describe, expect, it } from "vitest";
import {
  collectGuardRefusalPrefixes,
  isGuardPolicyRefusalText,
} from "./openai-http-guard-refusal.js";
import type { OpenClawConfig } from "../config/types.js";

describe("openai-http-guard-refusal", () => {
  it("matches configured refusalText and built-in prefixes", () => {
    const cfg = {
      plugins: {
        entries: {
          "guard-model": {
            config: { refusalText: "Custom deny." },
          },
        },
      },
    } as OpenClawConfig;
    const prefixes = collectGuardRefusalPrefixes(cfg);
    expect(isGuardPolicyRefusalText("Custom deny. reason", prefixes)).toBe(true);
    expect(
      isGuardPolicyRefusalText(
        "Blocked by guard model. credential_or_secret_access; none",
        prefixes,
      ),
    ).toBe(true);
    expect(isGuardPolicyRefusalText("fetch failed", prefixes)).toBe(false);
  });

  it("matches default guard copy without plugin config", () => {
    const prefixes = collectGuardRefusalPrefixes({} as OpenClawConfig);
    expect(
      isGuardPolicyRefusalText(
        "Blocked by guard model: probable prompt injection detected. x",
        prefixes,
      ),
    ).toBe(true);
  });
});
