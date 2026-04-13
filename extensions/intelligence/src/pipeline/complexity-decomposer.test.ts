import { describe, it, expect } from "vitest";
import { analyzeComplexity } from "./complexity-decomposer.js";

describe("analyzeComplexity", () => {
  // 1. Trivial prompts
  describe("trivial prompts", () => {
    it("returns low complexity for 'what time is it?'", () => {
      const result = analyzeComplexity("what time is it?");
      expect(result.complexity).toBeLessThan(0.2);
      expect(result.needsDecomposition).toBe(false);
    });

    it("returns low complexity for 'hello'", () => {
      const result = analyzeComplexity("hello");
      expect(result.complexity).toBeLessThan(0.2);
      expect(result.needsDecomposition).toBe(false);
      expect(result.indicators).toHaveLength(0);
    });
  });

  // 2. Low complexity — detects testing indicator
  it("detects testing indicator for a simple unit test request", () => {
    const result = analyzeComplexity("write a simple unit test for a function");
    expect(result.complexity).toBeGreaterThanOrEqual(0.1);
    expect(result.complexity).toBeLessThan(0.5);
    const testingIndicator = result.indicators.find((i) => i.indicator === "testing");
    expect(testingIndicator).toBeDefined();
    expect(testingIndicator!.matches.length).toBeGreaterThan(0);
  });

  // 3. Medium complexity — database + optimization
  it("returns medium complexity when database and optimization are mentioned", () => {
    const result = analyzeComplexity(
      "Build a production-ready database layer with caching and performance optimization for our postgres queries"
    );
    expect(result.complexity).toBeGreaterThanOrEqual(0.4);
    expect(result.complexity).toBeLessThanOrEqual(0.8);
    const indicatorNames = result.indicators.map((i) => i.indicator);
    expect(indicatorNames).toContain("database");
    expect(indicatorNames).toContain("optimization");
  });

  // 4. High complexity — auth + realtime + algorithms + database
  it("returns high complexity when auth, realtime, algorithms, and database are present", () => {
    const result = analyzeComplexity(
      "Build a realtime collaborative editor with websocket support, JWT authentication, " +
      "conflict resolution algorithms using CRDT, backed by a postgres database"
    );
    expect(result.complexity).toBeGreaterThanOrEqual(0.7);
    expect(result.complexity).toBeLessThanOrEqual(1.0);
    expect(result.needsDecomposition).toBe(true);
    const indicatorNames = result.indicators.map((i) => i.indicator);
    expect(indicatorNames).toContain("authentication");
    expect(indicatorNames).toContain("realtime");
    expect(indicatorNames).toContain("algorithms");
    expect(indicatorNames).toContain("database");
  });

  // 5. Feature counting with bullet points
  it("counts bullet points as features", () => {
    const input = "- item one\n- item two\n- item three\n- item four";
    const result = analyzeComplexity(input);
    expect(result.featureCount).toBe(4);
  });

  // 6. Feature counting with numbered lists
  it("counts numbered list items as features", () => {
    const input = "1. first\n2. second";
    const result = analyzeComplexity(input);
    expect(result.featureCount).toBe(2);
  });

  // 7. needsDecomposition true when featureCount > 3
  it("sets needsDecomposition to true when featureCount exceeds 3", () => {
    const input = "- alpha\n- bravo\n- charlie\n- delta";
    const result = analyzeComplexity(input);
    expect(result.featureCount).toBe(4);
    expect(result.needsDecomposition).toBe(true);
  });

  // 8. needsDecomposition true when complexity > 0.4
  it("sets needsDecomposition to true when complexity exceeds 0.4", () => {
    const result = analyzeComplexity(
      "Implement JWT authentication with session management, a database ORM layer, and realtime websocket updates"
    );
    expect(result.complexity).toBeGreaterThan(0.4);
    expect(result.needsDecomposition).toBe(true);
  });

  // 9. multipleFeatures weight capped at 10 matches
  it("caps multipleFeatures effective weight at 10 matches", () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `- feature ${i + 1}`).join("\n");
    const result = analyzeComplexity(bullets);
    const mfIndicator = result.indicators.find((i) => i.indicator === "multipleFeatures");
    expect(mfIndicator).toBeDefined();
    // Weight should be 0.05 * 10 = 0.5, not 0.05 * 20
    expect(mfIndicator!.weight).toBe(0.05 * 10);
  });

  // 10. Empty string
  it("handles empty string with zero complexity and featureCount", () => {
    const result = analyzeComplexity("");
    expect(result.complexity).toBe(0);
    expect(result.featureCount).toBe(0);
    // "".split(/\s+/) returns [""], so wordCount is 1
    expect(result.wordCount).toBe(1);
    expect(result.indicators).toHaveLength(0);
    expect(result.needsDecomposition).toBe(false);
  });

  // 11. Very long prompt with all indicators — clamped to 1.0
  it("clamps complexity to 1.0 even when all indicators match heavily", () => {
    const allIndicators = [
      "Build multiple endpoints and several APIs",
      "with realtime websocket live updates",
      "JWT authentication and oauth session login permissions",
      "postgres database with prisma ORM and SQL queries",
      "unit test cases with jest and vitest spec files",
      "CRDT algorithm with operational transform conflict resolution",
      "optimize performance with caching and rate limiting",
      "production-ready scalable enterprise system",
      "comprehensive complete full entire coverage",
      ...Array.from({ length: 15 }, (_, i) => `- feature ${i + 1}`),
    ];
    const result = analyzeComplexity(allIndicators.join("\n"));
    expect(result.complexity).toBeLessThanOrEqual(1.0);
    expect(result.needsDecomposition).toBe(true);
  });

  // 12. wordCount accuracy
  it("accurately counts words in a prompt", () => {
    const input = "one two three four five";
    const result = analyzeComplexity(input);
    expect(result.wordCount).toBe(5);
  });

  // 13. Indicators array includes correct indicator names and match strings
  it("populates indicator names and match strings correctly", () => {
    const result = analyzeComplexity("add JWT authentication and a postgres database");
    const authIndicator = result.indicators.find((i) => i.indicator === "authentication");
    expect(authIndicator).toBeDefined();
    expect(authIndicator!.matches).toEqual(expect.arrayContaining([expect.stringMatching(/JWT|auth/i)]));

    const dbIndicator = result.indicators.find((i) => i.indicator === "database");
    expect(dbIndicator).toBeDefined();
    expect(dbIndicator!.matches).toEqual(expect.arrayContaining([expect.stringMatching(/postgres|database/i)]));
  });

  // 14. algorithms keyword has highest effective weight among single-match indicators
  it("gives algorithms the highest effective weight among single-match indicators", () => {
    const result = analyzeComplexity(
      "Implement an algorithm with JWT auth, realtime websocket, postgres database, " +
      "caching optimization, production-ready, comprehensive unit test with multiple endpoints"
    );
    const singleMatchIndicators = result.indicators.filter(
      (i) => i.indicator !== "multipleFeatures"
    );
    const algorithmsIndicator = singleMatchIndicators.find((i) => i.indicator === "algorithms");
    expect(algorithmsIndicator).toBeDefined();
    const maxWeight = Math.max(...singleMatchIndicators.map((i) => i.weight));
    expect(algorithmsIndicator!.weight).toBe(maxWeight);
    expect(algorithmsIndicator!.weight).toBe(0.25);
  });

  // 15. Mixed bullet and numbered list feature counting
  it("sums bullet and numbered features together", () => {
    const input = "- alpha\n- bravo\n1. charlie\n2. delta\n3. echo";
    const result = analyzeComplexity(input);
    expect(result.featureCount).toBe(5);
  });

  // 16. Matches are sliced to at most 3 entries
  it("limits matches to at most 3 entries per indicator", () => {
    // multipleFeatures with global flag can produce many matches
    const bullets = Array.from({ length: 8 }, (_, i) => `- item ${i + 1}`).join("\n");
    const result = analyzeComplexity(bullets);
    for (const indicator of result.indicators) {
      expect(indicator.matches.length).toBeLessThanOrEqual(3);
    }
  });
});
