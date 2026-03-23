/**
 * Refusal Detector
 *
 * Detects when the AI model refuses, deflects, or provides
 * incomplete responses instead of completing the task.
 *
 * Ported from AICodeAssistant RefusalDetector.js
 */

export interface RefusalResult {
  isRefusal: boolean;
  refusalType: string | null;
  confidence: number;
  triggers: string[];
  detectedTypes?: string[];
  maxSeverity?: string;
  recommendation: string | null;
  analysis?: {
    totalTriggers: number;
    highSeverity: number;
    patterns: TriggerMatch[];
  };
}

interface TriggerMatch {
  matched: string;
  type: string;
  severity: string;
}

interface RefusalPattern {
  pattern: RegExp;
  type: string;
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
}

/**
 * Refusal patterns with types and severity
 */
const REFUSAL_PATTERNS: RefusalPattern[] = [
  // Direct refusals
  {
    pattern: /this (request|task|implementation) is too (extensive|complex|large)/i,
    type: 'complexity_refusal',
    severity: 'high',
    recommendation: 'decompose_and_retry',
  },
  {
    pattern: /too extensive to implement/i,
    type: 'complexity_refusal',
    severity: 'high',
    recommendation: 'decompose_and_retry',
  },
  {
    pattern: /I can provide a high-level/i,
    type: 'downgrade_refusal',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /provide (an? )?(overview|high-level|outline)/i,
    type: 'downgrade_refusal',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /however.*I can/i,
    type: 'downgrade_refusal',
    severity: 'medium',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /instead,?\s*I\s*(will|can|'ll)\s*(outline|provide|give|show)/i,
    type: 'downgrade_refusal',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /I\s*(cannot|can't|am unable to)\s*(provide|generate|create|implement)/i,
    type: 'capability_refusal',
    severity: 'high',
    recommendation: 'simplify_or_escalate',
  },
  {
    pattern: /due to\s*(its|the)\s*(complexity|length|scope)/i,
    type: 'scope_refusal',
    severity: 'medium',
    recommendation: 'decompose_and_retry',
  },

  // Placeholder indicators
  {
    pattern: /implement\s*(this|the|your)\s*(logic|code|functionality)\s*here/i,
    type: 'placeholder',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /\/\/\s*(TODO|FIXME|IMPLEMENT|ADD)/i,
    type: 'placeholder',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /\.\.\.\s*(implement|add|complete|continue)/i,
    type: 'placeholder',
    severity: 'medium',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /placeholder/i,
    type: 'placeholder',
    severity: 'high',
    recommendation: 'enforce_completion',
  },

  // Partial delivery indicators
  {
    pattern: /high-level\s*(structure|overview|outline)/i,
    type: 'partial_delivery',
    severity: 'medium',
    recommendation: 'request_implementation',
  },
  {
    pattern: /this\s*(provides|gives|shows)\s*(the|a)\s*(foundation|base|starting point)/i,
    type: 'partial_delivery',
    severity: 'medium',
    recommendation: 'request_implementation',
  },
  {
    pattern: /should be\s*(expanded|extended|completed|implemented)/i,
    type: 'partial_delivery',
    severity: 'medium',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /are\s*placeholders?\s*and\s*should/i,
    type: 'partial_delivery',
    severity: 'high',
    recommendation: 'enforce_completion',
  },

  // Analysis instead of code patterns
  {
    pattern: /^(##?\s*)?Overview\b/im,
    type: 'analysis_instead_of_code',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /^(##?\s*)?Conclusion\b/im,
    type: 'analysis_instead_of_code',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /Side-by-Side Comparison/i,
    type: 'analysis_instead_of_code',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /\b(Pros|Cons):/i,
    type: 'analysis_instead_of_code',
    severity: 'medium',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /^Core Features$/im,
    type: 'analysis_instead_of_code',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /provides a starting point/i,
    type: 'partial_delivery',
    severity: 'high',
    recommendation: 'enforce_completion',
  },

  // Deflection patterns
  {
    pattern: /would you like me to\s*(focus|concentrate|elaborate|explain)/i,
    type: 'deflection',
    severity: 'low',
    recommendation: 'redirect_to_task',
  },
  {
    pattern: /want me to\s*(check|look|search|find)/i,
    type: 'deflection',
    severity: 'low',
    recommendation: 'redirect_to_task',
  },
  {
    pattern: /there are placeholders remaining/i,
    type: 'self_aware_incomplete',
    severity: 'high',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /should I complete them/i,
    type: 'self_aware_incomplete',
    severity: 'high',
    recommendation: 'enforce_completion',
  },

  // Excuse patterns
  {
    pattern: /in a single response/i,
    type: 'length_excuse',
    severity: 'medium',
    recommendation: 'multi_part_generation',
  },
  {
    pattern: /beyond the scope/i,
    type: 'scope_excuse',
    severity: 'medium',
    recommendation: 'enforce_completion',
  },
  {
    pattern: /for brevity/i,
    type: 'brevity_excuse',
    severity: 'low',
    recommendation: 'request_full_version',
  },
];

/**
 * Incomplete code indicators
 */
const INCOMPLETE_CODE_PATTERNS: RegExp[] = [
  /\/\/\s*\.\.\./, // // ...
  /\/\*\s*\.\.\.\s*\*\//, // /* ... */
  /\{\s*\/\/.*\n?\s*\}/, // { // comment only }
  /\{\s*\}/, // Empty blocks (context-dependent)
  /throw new Error\(['"]not implemented/i, // throw new Error("not implemented")
  /pass\s*$/m, // Python pass
  /NotImplementedError/, // Python NotImplementedError
  /unimplemented!/, // Rust unimplemented!
  /todo!/, // Rust todo!
];

/**
 * Detect refusals in a response
 */
export function detectRefusal(
  response: string,
  _options: Record<string, unknown> = {}
): RefusalResult {
  if (!response || typeof response !== 'string') {
    return {
      isRefusal: false,
      refusalType: null,
      confidence: 0,
      triggers: [],
      recommendation: null,
    };
  }

  const triggers: TriggerMatch[] = [];
  const detectedTypes = new Set<string>();
  let maxSeverity: string = 'none';
  let recommendation: string | null = null;
  const severityOrder: Record<string, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
  };

  // Check text patterns
  for (const { pattern, type, severity, recommendation: rec } of REFUSAL_PATTERNS) {
    const match = response.match(pattern);
    if (match) {
      triggers.push({
        matched: match[0],
        type,
        severity,
      });
      detectedTypes.add(type);

      if (severityOrder[severity] > severityOrder[maxSeverity]) {
        maxSeverity = severity;
        recommendation = rec;
      }
    }
  }

  // Check for incomplete code patterns
  for (const pattern of INCOMPLETE_CODE_PATTERNS) {
    if (pattern.test(response)) {
      triggers.push({
        matched: response.match(pattern)?.[0] || '',
        type: 'incomplete_code',
        severity: 'medium',
      });
      detectedTypes.add('incomplete_code');
    }
  }

  // Calculate confidence based on triggers
  const confidence = Math.min(1, triggers.length * 0.25);

  // High confidence refusal if multiple high-severity triggers
  const highSeverityCount = triggers.filter((t) => t.severity === 'high').length;
  const isRefusal = highSeverityCount >= 1 || triggers.length >= 3;

  return {
    isRefusal,
    refusalType:
      detectedTypes.size > 0 ? Array.from(detectedTypes).join(', ') : null,
    confidence,
    triggers: triggers.map((t) => t.matched),
    detectedTypes: Array.from(detectedTypes),
    maxSeverity,
    recommendation,
    analysis: {
      totalTriggers: triggers.length,
      highSeverity: highSeverityCount,
      patterns: triggers,
    },
  };
}

/**
 * Generate a completion enforcement prompt based on refusal type
 */
export function generateCompletionPrompt(
  originalRequest: string,
  refusedResponse: string,
  refusalResult: RefusalResult
): string {
  const basePrompt = `You previously attempted this request but provided an incomplete response.

## Original Request
${originalRequest}

## Your Previous Response (Incomplete)
${refusedResponse.slice(0, 2000)}...

## Issues Detected
${refusalResult.triggers.map((t) => `- ${t}`).join('\n')}

## Instructions
You MUST now provide a COMPLETE implementation. Do NOT:
- Say "this is too complex" or "too extensive"
- Use placeholders like "// implement here" or "TODO"
- Provide "high-level outlines" instead of working code
- Ask if I want you to continue

You MUST:
- Implement every function with actual working logic
- Include all error handling
- Provide complete, runnable code

If the task is large, implement it in logical sections but COMPLETE each section.
Start with the most critical component and provide FULL implementation.

BEGIN COMPLETE IMPLEMENTATION:`;

  // Add specific guidance based on refusal type
  if (
    refusalResult.detectedTypes?.includes('complexity_refusal') ||
    refusalResult.detectedTypes?.includes('analysis_instead_of_code')
  ) {
    return `CRITICAL: Your previous response was REJECTED for not providing code.

## Original Request
${originalRequest}

## MANDATORY REQUIREMENTS
You MUST start your response with \`\`\`typescript on line 1.
NO text, NO "Overview", NO "Conclusion", NO analysis before code.

## Implementation Order (provide COMPLETE code for each):

### Part 1: Types and Interfaces
\`\`\`typescript
// Define all types and interfaces here
\`\`\`

### Part 2: Core Implementation
\`\`\`typescript
// Implement main classes and functions with FULL logic
\`\`\`

### Part 3: API/Routes
\`\`\`typescript
// Complete API implementation
\`\`\`

FAILURE CONDITIONS (will be rejected):
- Any text before \`\`\`typescript
- "Overview", "Conclusion", "Pros/Cons" sections
- Placeholder comments like "// TODO" or "// implement here"
- Saying "too complex" or "cannot implement"

START WITH \`\`\`typescript NOW:`;
  }

  if (refusalResult.detectedTypes?.includes('placeholder')) {
    return (
      basePrompt +
      `

Replace ALL placeholders with actual implementations.
Every function must have real logic, not comments.`
    );
  }

  return basePrompt;
}

/**
 * Check if a response needs completion enforcement
 */
export function needsEnforcement(response: string): boolean {
  const result = detectRefusal(response);
  return result.isRefusal;
}

/**
 * Get severity score for a response (0-1, higher = more problematic)
 */
export function getSeverityScore(response: string): number {
  const result = detectRefusal(response);

  if (!result.isRefusal) return 0;

  const severityWeights: Record<string, number> = {
    low: 0.25,
    medium: 0.5,
    high: 1.0,
  };
  const totalWeight = result.analysis!.patterns.reduce(
    (sum, p) => sum + (severityWeights[p.severity] || 0),
    0
  );

  return Math.min(1, totalWeight / 3);
}

export interface RefusalDetectorInstance {
  detect: typeof detectRefusal;
  needsEnforcement: typeof needsEnforcement;
  getSeverityScore: typeof getSeverityScore;
  generateCompletionPrompt: typeof generateCompletionPrompt;
}

// Singleton
let detectorInstance: RefusalDetectorInstance | null = null;

export function getRefusalDetector(): RefusalDetectorInstance {
  if (!detectorInstance) {
    detectorInstance = {
      detect: detectRefusal,
      needsEnforcement,
      getSeverityScore,
      generateCompletionPrompt,
    };
  }
  return detectorInstance;
}
