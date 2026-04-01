import { describe, it, expect } from "vitest";
import { assessQuality } from "./quality-gate.js";

describe("assessQuality", () => {
  // ========================================================================
  // Pass verdict
  // ========================================================================

  describe("pass verdict", () => {
    it("passes a clean code response", () => {
      const response = `Here is the implementation:

\`\`\`typescript
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

This function takes two numbers and returns their sum.`;

      const result = assessQuality(response);
      expect(result.verdict).toBe("pass");
      expect(result.issues).toHaveLength(0);
      expect(result.score).toBe(1.0);
    });

    it("passes a response with ## Overview heading (not a refusal)", () => {
      const response = `## Overview

This module handles authentication using JWT tokens with refresh token rotation.

## Implementation Details

The auth middleware extracts the Bearer token from the Authorization header and validates it against the signing key.`;

      const result = assessQuality(response);
      expect(result.verdict).toBe("pass");
      expect(result.issues).toHaveLength(0);
    });

    it("passes a response with Pros/Cons analysis", () => {
      const response = `## Comparison

**Pros:**
- Fast lookup time O(1)
- Simple implementation

**Cons:**
- Higher memory usage
- No ordering guarantee

## Conclusion

Use a HashMap for this use case.`;

      const result = assessQuality(response);
      expect(result.verdict).toBe("pass");
    });

    it("passes a plain text response with no code", () => {
      const response = "The error is caused by a missing null check on line 42. The variable `user` can be undefined when the session expires.";
      const result = assessQuality(response);
      expect(result.verdict).toBe("pass");
      expect(result.score).toBe(1.0);
    });
  });

  // ========================================================================
  // Flag verdict
  // ========================================================================

  describe("flag verdict", () => {
    it("flags a single TODO placeholder", () => {
      const response = `\`\`\`typescript
export function processOrder(order: Order) {
  // TODO: implement validation
  return order;
}
\`\`\``;

      const result = assessQuality(response);
      expect(result.verdict).toBe("flag");
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      expect(result.issues.some((i) => i.type === "placeholder")).toBe(true);
    });

    it("flags trailing ellipsis truncation", () => {
      const response = "Here is the implementation of the rate limiter. First we need to create the middleware...";
      const result = assessQuality(response);
      expect(result.verdict).toBe("flag");
      expect(result.issues.some((i) => i.type === "truncation")).toBe(true);
    });

    it("flags unbalanced code fences", () => {
      const response = "```typescript\nexport function foo() {\n  return 42;\n}\n";
      const result = assessQuality(response);
      expect(result.verdict).toBe("flag");
      expect(result.issues.some((i) => i.description.includes("Unbalanced"))).toBe(true);
    });

    it("flags ellipsis comments (// ...)", () => {
      const response = `\`\`\`typescript
export class Server {
  start() {
    // ...
  }
}
\`\`\``;

      const result = assessQuality(response);
      expect(result.verdict).toBe("flag");
      expect(result.issues.some((i) => i.type === "incomplete_code")).toBe(true);
    });

    it("does not flag trailing ... inside a code block", () => {
      const response = `\`\`\`typescript
const message = "Loading..."
\`\`\`

That's the complete implementation.`;

      const result = assessQuality(response);
      // The trailing ... is inside a code block, should not be flagged as truncation
      expect(result.issues.filter((i) => i.type === "truncation")).toHaveLength(0);
    });
  });

  // ========================================================================
  // Retry verdict
  // ========================================================================

  describe("retry verdict", () => {
    it("retries on explicit 'I cannot provide'", () => {
      const response = "I cannot provide a complete implementation of this system as it would require extensive setup.";
      const result = assessQuality(response);
      expect(result.verdict).toBe("retry");
      expect(result.issues.some((i) => i.type === "explicit_refusal")).toBe(true);
    });

    it("retries on 'this task is too complex'", () => {
      const response = "This task is too complex to implement in a single response. Let me outline the approach instead.";
      const result = assessQuality(response);
      expect(result.verdict).toBe("retry");
    });

    it("retries on 'too extensive to implement'", () => {
      const response = "This is too extensive to implement here. Here's a high-level overview instead.";
      const result = assessQuality(response);
      expect(result.verdict).toBe("retry");
    });

    it("retries on 'beyond my capabilities'", () => {
      const response = "This is beyond my capabilities to implement fully.";
      const result = assessQuality(response);
      expect(result.verdict).toBe("retry");
    });

    it("retries on 3+ placeholder issues", () => {
      const response = `\`\`\`typescript
function a() {
  // TODO: implement
}
function b() {
  // FIXME: broken
}
function c() {
  // TODO: add logic
}
\`\`\``;

      const result = assessQuality(response);
      expect(result.verdict).toBe("retry");
      expect(result.issues.filter((i) => i.type === "placeholder").length).toBeGreaterThanOrEqual(3);
    });
  });

  // ========================================================================
  // Score computation
  // ========================================================================

  describe("score computation", () => {
    it("returns 1.0 for clean response", () => {
      const result = assessQuality("This is a clean, complete response with no issues.");
      expect(result.score).toBe(1.0);
    });

    it("subtracts per issue type", () => {
      const response = "I cannot provide this implementation.";
      const result = assessQuality(response);
      expect(result.score).toBeLessThan(1.0);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("clamps score to 0 for many issues", () => {
      const response = `I cannot create this. This request is too extensive to implement.
\`\`\`
// TODO: everything
// FIXME: nothing works
// TODO: add auth
throw new Error("not implemented")
\`\`\``;

      const result = assessQuality(response);
      expect(result.score).toBe(0);
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = assessQuality("");
      expect(result.verdict).toBe("flag");
      expect(result.score).toBe(0);
    });

    it("handles null/undefined coerced to string", () => {
      const result = assessQuality(null as any);
      expect(result.verdict).toBe("flag");
    });
  });
});
