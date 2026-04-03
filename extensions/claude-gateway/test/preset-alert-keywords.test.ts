import { describe, it, expect } from "vitest";
import { detectAlertKeywords } from "../src/preset-alert-keywords.js";

describe("PresetAlertKeywords", () => {
  it("no keywords detected in clean text", () => {
    const result = detectAlertKeywords("All systems operational. Everything looks good.");

    expect(result.detected).toBe(false);
    expect(result.severity).toBe("info");
  });

  it("detects WARNING", () => {
    const result = detectAlertKeywords("WARNING: Disk usage is at 85%");

    expect(result.detected).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it("detects CRITICAL", () => {
    const result = detectAlertKeywords("CRITICAL: Database connection lost");

    expect(result.detected).toBe(true);
    expect(result.severity).toBe("critical");
  });

  it("CRITICAL takes precedence over WARNING", () => {
    const result = detectAlertKeywords(
      "WARNING: Disk usage high. CRITICAL: Service down.",
    );

    expect(result.detected).toBe(true);
    expect(result.severity).toBe("critical");
  });

  it("case insensitive detection", () => {
    const lower = detectAlertKeywords("warning: something happened");
    expect(lower.detected).toBe(true);
    expect(lower.severity).toBe("warning");

    const mixed = detectAlertKeywords("Warning: check this out");
    expect(mixed.detected).toBe(true);
    expect(mixed.severity).toBe("warning");

    const upper = detectAlertKeywords("WARNING: loud problem");
    expect(upper.detected).toBe(true);
    expect(upper.severity).toBe("warning");

    const critLower = detectAlertKeywords("critical failure detected");
    expect(critLower.detected).toBe(true);
    expect(critLower.severity).toBe("critical");
  });

  it("custom keyword list — only those are checked", () => {
    const customKeywords = ["OUTAGE", "BREACH"];

    // Default keywords should NOT be detected
    const withDefault = detectAlertKeywords("WARNING: something", customKeywords);
    expect(withDefault.detected).toBe(false);
    expect(withDefault.severity).toBe("info");

    // Custom keywords should be detected
    const withCustom = detectAlertKeywords("OUTAGE detected in region us-east", customKeywords);
    expect(withCustom.detected).toBe(true);
    expect(withCustom.severity).toBe("warning");

    // CRITICAL is not in custom list, so even "CRITICAL" is not severity=critical
    const noCritical = detectAlertKeywords("BREACH and CRITICAL found", customKeywords);
    expect(noCritical.detected).toBe(true);
    // CRITICAL is not in the custom list, so no "critical" severity upgrade
    expect(noCritical.severity).toBe("warning");
  });
});
