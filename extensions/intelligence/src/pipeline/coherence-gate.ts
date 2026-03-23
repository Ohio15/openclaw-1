/**
 * CoherenceGate - Final validation before response delivery
 *
 * ARCHITECTURAL ROLE: COHERENCE VALIDATION GATE
 * - Ensures response matches classified intent
 * - Detects stale references from previous tasks
 * - Validates that blocking operations actually block
 * - Discards and regenerates if coherence fails
 *
 * Ported from AICodeAssistant CoherenceGate.js
 */

import { getAlgorithmValidator } from './algorithm-validator.js';
import { getIntentTemplateLock } from './intent-template-lock.js';

export interface CoherenceValidationResult {
  pass: boolean;
  action?: string;
  failedChecks?: string[];
  checks: CoherenceChecks;
  details: Record<string, any>;
  regenerationHints?: string;
}

export interface CoherenceChecks {
  intentMatch: boolean;
  noStaleReferences: boolean;
  activeBlocking: boolean;
  coherent: boolean;
}

export interface IntentMatchResult {
  matches: boolean;
  present: string[];
  missing: string[];
  forbidden: string[];
}

export interface StaleReferenceResult {
  hasStaleReferences: boolean;
  found: string[];
}

export interface BlockingValidationResult {
  blocks: boolean;
  hasStatusSet: boolean;
  hasReturn: boolean;
  hasNextSkip: boolean;
  explanation: string;
}

export interface CoherenceContext {
  intent?: string;
  algorithmType?: string;
  forbiddenPatterns?: RegExp[];
}

export interface CoherenceResponse {
  code?: string;
  content?: string;
}

interface IntentCoherenceConfig {
  mustHave: { pattern: RegExp; name: string }[];
  mustBlock: boolean;
  mustNotHave: { pattern: RegExp; name: string }[];
}

/**
 * Intent-specific coherence checks
 */
const INTENT_COHERENCE_CHECKS: Record<string, IntentCoherenceConfig> = {
  'rate-limiting': {
    mustHave: [
      { pattern: /429|Too Many/i, name: 'HTTP 429 response' },
      {
        pattern: /(?:req|request)\.ip|userId|clientId|identifier/i,
        name: 'Client identification',
      },
    ],
    mustBlock: true,
    mustNotHave: [
      { pattern: /debounce/i, name: 'Debounce reference' },
      { pattern: /throttle.*delay/i, name: 'Throttle delay pattern' },
    ],
  },
  'sliding-window-rate-limiting': {
    mustHave: [
      { pattern: /429/i, name: 'HTTP 429 response' },
      {
        pattern: /timestamps|requestHistory|history/i,
        name: 'Timestamp tracking',
      },
      { pattern: /filter|while.*shift/i, name: 'Window filtering' },
    ],
    mustBlock: true,
    mustNotHave: [
      {
        pattern: /setTimeout\s*\([^)]*clearTimeout/i,
        name: 'Debounce pattern',
      },
    ],
  },
  debounce: {
    mustHave: [
      { pattern: /setTimeout/i, name: 'setTimeout call' },
      { pattern: /clearTimeout/i, name: 'clearTimeout call' },
    ],
    mustBlock: false,
    mustNotHave: [
      { pattern: /429/i, name: 'HTTP 429' },
      { pattern: /rate.?limit/i, name: 'Rate limit reference' },
    ],
  },
};

export class CoherenceGate {
  private stats: {
    validations: number;
    passed: number;
    failed: number;
    staleReferences: number;
    blockingFailures: number;
  };

  constructor() {
    this.stats = {
      validations: 0,
      passed: 0,
      failed: 0,
      staleReferences: 0,
      blockingFailures: 0,
    };
  }

  /**
   * Validate response coherence
   */
  async validate(
    response: CoherenceResponse | string,
    context: CoherenceContext
  ): Promise<CoherenceValidationResult> {
    this.stats.validations++;

    const code =
      typeof response === 'string'
        ? response
        : response.code || response.content || '';
    const intent = context.intent || context.algorithmType || 'unknown';

    const checks: CoherenceChecks = {
      intentMatch: false,
      noStaleReferences: false,
      activeBlocking: true, // Default true, only checked for blocking intents
      coherent: false,
    };

    const details: Record<string, any> = {};

    // 1. Does code match the classified intent?
    const intentResult = this.validateIntentMatch(code, intent);
    checks.intentMatch = intentResult.matches;
    details.intentMatch = intentResult;

    // 2. No references to previous tasks?
    const staleResult = this.detectStaleReferences(code, context);
    checks.noStaleReferences = !staleResult.hasStaleReferences;
    details.staleReferences = staleResult;

    if (staleResult.hasStaleReferences) {
      this.stats.staleReferences++;
    }

    // 3. For blocking operations, does it actually block?
    const coherenceConfig = INTENT_COHERENCE_CHECKS[intent];
    if (coherenceConfig?.mustBlock) {
      const blockingResult = this.validateActiveBlocking(code);
      checks.activeBlocking = blockingResult.blocks;
      details.activeBlocking = blockingResult;

      if (!blockingResult.blocks) {
        this.stats.blockingFailures++;
      }
    }

    // 4. Overall coherence
    checks.coherent = Object.values(checks).every((v) => v === true);

    if (checks.coherent) {
      this.stats.passed++;
      return {
        pass: true,
        checks,
        details,
      };
    }

    this.stats.failed++;

    const failedChecks = Object.entries(checks)
      .filter(([_, v]) => !v)
      .map(([k]) => k);

    return {
      pass: false,
      action: 'DISCARD_AND_REGENERATE',
      failedChecks,
      checks,
      details,
      regenerationHints: this.buildRegenerationHints(
        failedChecks,
        details,
        intent
      ),
    };
  }

  /**
   * Validate that code matches the classified intent
   */
  validateIntentMatch(code: string, intent: string): IntentMatchResult {
    const config = INTENT_COHERENCE_CHECKS[intent];

    if (!config) {
      // Unknown intent - use algorithm validator
      const validator = getAlgorithmValidator();
      const result = validator.validate(code, intent);
      return {
        matches: result.valid,
        present: result.satisfied,
        missing: result.missing,
        forbidden: result.forbidden,
      };
    }

    const present: string[] = [];
    const missing: string[] = [];
    const forbidden: string[] = [];

    // Check must-have patterns
    for (const check of config.mustHave || []) {
      if (check.pattern.test(code)) {
        present.push(check.name);
      } else {
        missing.push(check.name);
      }
    }

    // Check must-not-have patterns
    for (const check of config.mustNotHave || []) {
      if (check.pattern.test(code)) {
        forbidden.push(check.name);
      }
    }

    return {
      matches: missing.length === 0 && forbidden.length === 0,
      present,
      missing,
      forbidden,
    };
  }

  /**
   * Detect stale references from previous tasks
   */
  detectStaleReferences(
    code: string,
    context: CoherenceContext
  ): StaleReferenceResult {
    const found: string[] = [];

    // Check context-provided forbidden patterns
    const forbiddenPatterns = context.forbiddenPatterns || [];
    for (const pattern of forbiddenPatterns) {
      if (pattern instanceof RegExp && pattern.test(code)) {
        found.push(`Pattern: ${pattern.source}`);
      }
    }

    // Check intent-template lock for forbidden patterns
    const lock = getIntentTemplateLock();
    const lockResult = lock.validateCodeForIntent(context.intent || '', code);
    if (!lockResult.valid) {
      found.push(...lockResult.violations);
    }

    // Generic stale reference detection
    const genericStalePatterns: RegExp[] = [
      // Comments referencing different tasks
      /\/\/\s*(?:debounce|throttle)\s*(?:implementation|logic|pattern)/i,
      /\/\/\s*(?:from|based on)\s*(?:previous|earlier|above)/i,
      // Variable names from wrong algorithms
      /(?:debounced|throttled)(?:Fn|Function|Handler)/i,
    ];

    // Only check generic patterns if they conflict with current intent
    if (
      context.intent === 'rate-limiting' ||
      context.intent === 'sliding-window-rate-limiting'
    ) {
      for (const pattern of genericStalePatterns) {
        if (pattern.test(code)) {
          found.push(`Generic stale pattern: ${pattern.source}`);
        }
      }
    }

    return {
      hasStaleReferences: found.length > 0,
      found,
    };
  }

  /**
   * Validate that rate limiting code actually blocks requests
   */
  validateActiveBlocking(code: string): BlockingValidationResult {
    // Check for HTTP 429 status being set
    const hasStatusSet =
      /res\.status\s*\(\s*429\s*\)|\.statusCode\s*=\s*429|status\s*:\s*429/i.test(
        code
      );

    // Check for response being sent after status
    const hasReturn = /return\s+res\.|res\.(send|json|end)\s*\(/i.test(code);

    // Check that next() is NOT called when blocking
    const has429Return =
      /status\s*\(\s*429\s*\)[^}]*return|return[^}]*status\s*\(\s*429\s*\)/i.test(
        code
      );
    const hasNextAfter429 =
      /status\s*\(\s*429\s*\)[^}]*next\s*\(\s*\)/i.test(code);

    const hasNextSkip = has429Return || !hasNextAfter429;

    // For valid blocking: must set 429 status AND (return response OR not call next)
    const blocks = hasStatusSet && (hasReturn || hasNextSkip);

    return {
      blocks,
      hasStatusSet,
      hasReturn,
      hasNextSkip,
      explanation: blocks
        ? 'Code correctly blocks requests when rate limit exceeded'
        : 'Code does not properly block requests - missing status(429), return, or incorrectly calls next()',
    };
  }

  /**
   * Build hints for regeneration
   */
  buildRegenerationHints(
    failedChecks: string[],
    details: Record<string, any>,
    _intent: string
  ): string {
    const hints: string[] = [];

    if (failedChecks.includes('intentMatch')) {
      if (details.intentMatch?.missing?.length > 0) {
        hints.push(
          `MISSING REQUIRED: ${details.intentMatch.missing.join(', ')}`
        );
      }
      if (details.intentMatch?.forbidden?.length > 0) {
        hints.push(
          `FORBIDDEN PRESENT: ${details.intentMatch.forbidden.join(', ')}`
        );
      }
    }

    if (failedChecks.includes('noStaleReferences')) {
      hints.push(
        'CONTAMINATION: Code contains references from a different task type'
      );
      hints.push(
        `Remove: ${details.staleReferences?.found?.join(', ')}`
      );
    }

    if (failedChecks.includes('activeBlocking')) {
      hints.push(
        'BLOCKING FAILURE: Rate limiter must actually block requests'
      );
      hints.push(
        'Required: res.status(429) followed by return or res.send()'
      );
      hints.push('Do NOT call next() after setting 429 status');
    }

    return hints.join('\n');
  }

  /**
   * Get validation statistics
   */
  getStats(): {
    validations: number;
    passed: number;
    failed: number;
    staleReferences: number;
    blockingFailures: number;
  } {
    return { ...this.stats };
  }

  /**
   * Reset statistics (for testing)
   */
  resetStats(): void {
    this.stats = {
      validations: 0,
      passed: 0,
      failed: 0,
      staleReferences: 0,
      blockingFailures: 0,
    };
  }
}

// Singleton
let gateInstance: CoherenceGate | null = null;

export function getCoherenceGate(): CoherenceGate {
  if (!gateInstance) {
    gateInstance = new CoherenceGate();
  }
  return gateInstance;
}
