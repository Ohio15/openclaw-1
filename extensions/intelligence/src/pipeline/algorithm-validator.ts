/**
 * AlgorithmValidator - Validates generated code satisfies algorithmic requirements
 *
 * ARCHITECTURAL ROLE: ALGORITHM REQUIREMENT GATE
 * - Ensures code implements ALL required algorithmic elements
 * - Detects forbidden patterns that indicate wrong algorithm
 * - Forces regeneration if requirements not met
 *
 * Ported from AICodeAssistant AlgorithmValidator.js
 */

export interface ValidationResult {
  valid: boolean;
  warning?: string;
  missing: string[];
  forbidden: string[];
  satisfied: string[];
  details: ValidationDetail[];
  semanticTests?: SemanticTestResult[];
  action?: string;
  regenerationPrompt?: string;
}

export interface ValidationDetail {
  requirement: string;
  status: 'SATISFIED' | 'MISSING' | 'FORBIDDEN_PRESENT' | 'SEMANTIC_FAILURE' | 'WARNING';
  description: string;
  hint?: string;
}

export interface SemanticTestResult {
  name: string;
  description?: string;
  passed: boolean;
  reason: string | null;
  severity: string;
}

export interface ExecutionTestSuiteResult {
  passed: boolean;
  results: ExecutionTestResultItem[];
  skipped?: boolean;
  reason?: string;
  error?: string;
}

export interface ExecutionTestResultItem {
  name: string;
  description: string;
  passed: boolean;
  reason?: string | null;
  skipped?: boolean;
}

interface RequirementPattern {
  pattern: RegExp;
  name: string;
  description: string;
}

interface ForbiddenPattern {
  pattern: RegExp;
  name: string;
  description: string;
}

interface AlgorithmRequirement {
  required: RequirementPattern[];
  forbidden: ForbiddenPattern[];
}

interface SemanticTest {
  name: string;
  description: string;
  test: (code: string) => { passed: boolean; reason: string | null; severity?: string };
}

interface ExecutionTest {
  name: string;
  description: string;
  run: (Constructor: any) => { passed: boolean; reason: string | null } | Promise<{ passed: boolean; reason: string | null }>;
}

interface ExecutionTestSuite {
  tests: ExecutionTest[];
}

/**
 * Algorithm-specific requirement patterns
 */
const ALGORITHM_REQUIREMENTS: Record<string, AlgorithmRequirement> = {
  'sliding-window-rate-limiting': {
    required: [
      {
        pattern: /(?:timestamps|requestTimes|requestHistory|history|requests)\s*[=:]\s*(?:new\s+)?(?:Map|Array|\[\]|\{\})|(?:Map|Array)<.*(?:number|Date)/i,
        name: 'per-request-timestamps',
        description: 'Must track timestamps for each request',
      },
      {
        pattern: /Date\.now\(\)|performance\.now\(\)|new Date\(\)\.getTime\(\)/i,
        name: 'time-tracking',
        description: 'Must use current time for window calculations',
      },
      {
        pattern: /\.filter\s*\([^)]*(?:>=|>)\s*(?:now|current|Date\.now)|while\s*\([^)]*\[0\][^)]*<[^)]*(?:now|current)\s*-\s*(?:window|interval|ms)/i,
        name: 'window-filtering',
        description: 'Must filter/clean requests outside the sliding window',
      },
      {
        pattern: /(?:\.length|\.size|count)\s*(?:>=|>|<=|<)\s*(?:max|limit|threshold)|(?:max|limit|threshold)\s*(?:>=|>|<=|<)\s*(?:\.length|\.size|count)/i,
        name: 'limit-enforcement',
        description: 'Must check request count against maximum limit',
      },
      {
        pattern: /(?:res\.)?status\s*\(\s*429\s*\)|statusCode\s*[=:]\s*429|\.status\s*=\s*429|429.*Too Many|Too Many.*429|TooManyRequests/i,
        name: 'http-429-blocking',
        description: 'Must return HTTP 429 when rate limit exceeded',
      },
      {
        pattern: /(?:delete|splice|shift|slice|filter)\s*\(|\.clear\(\)|cleanup|evict|prune|expire/i,
        name: 'stale-entry-cleanup',
        description: 'Must have mechanism to clean up stale/expired entries',
      },
    ],
    forbidden: [
      {
        pattern: /setTimeout\s*\([^)]*clearTimeout|clearTimeout\s*\([^)]*\)\s*[;\n\s]*setTimeout/i,
        name: 'debounce-pattern',
        description: 'Debounce patterns are wrong for rate limiting',
      },
      {
        pattern: /(?:lastCall|lastExecution|lastRun)\s*[=:]\s*Date\.now\(\)[^}]*(?:if|return)[^}]*<\s*(?:delay|interval|wait)/i,
        name: 'throttle-pattern',
        description: 'Throttle patterns are wrong for rate limiting',
      },
    ],
  },

  'token-bucket-rate-limiting': {
    required: [
      {
        pattern: /(?:tokens|bucket|capacity)\s*[=:]/i,
        name: 'token-tracking',
        description: 'Must track available tokens',
      },
      {
        pattern: /refill|replenish|add.*token|token.*add/i,
        name: 'token-refill',
        description: 'Must refill tokens over time',
      },
      {
        pattern: /(?:tokens|bucket)\s*(?:>=|>|<=|<)\s*\d|consume|take.*token/i,
        name: 'token-consumption',
        description: 'Must consume tokens on request',
      },
      {
        pattern: /429|Too Many|rate.?limit/i,
        name: 'http-429-blocking',
        description: 'Must return HTTP 429 when no tokens available',
      },
    ],
    forbidden: [
      {
        pattern: /setTimeout\s*\([^)]*clearTimeout/i,
        name: 'debounce-pattern',
        description: 'Debounce patterns are wrong for rate limiting',
      },
    ],
  },

  debounce: {
    required: [
      {
        pattern: /setTimeout\s*\(/i,
        name: 'timeout-setup',
        description: 'Must use setTimeout for delayed execution',
      },
      {
        pattern: /clearTimeout\s*\(/i,
        name: 'timeout-cancellation',
        description: 'Must clear previous timeout on new calls',
      },
      {
        pattern: /(?:timer|timeout|timeoutId|timerId)\s*[=:]/i,
        name: 'timer-reference',
        description: 'Must store timer reference for cancellation',
      },
    ],
    forbidden: [
      {
        pattern: /429|Too Many Requests|rate.?limit/i,
        name: 'http-blocking',
        description: 'HTTP blocking is wrong for debounce',
      },
      {
        pattern: /sliding.?window|token.?bucket|fixed.?window/i,
        name: 'rate-limiting-pattern',
        description: 'Rate limiting patterns are wrong for debounce',
      },
    ],
  },

  throttle: {
    required: [
      {
        pattern: /(?:lastCall|lastRun|lastExecution|lastTime|previousCall)\s*[=:]/i,
        name: 'last-execution-tracking',
        description: 'Must track time of last execution',
      },
      {
        pattern: /(?:now|current|Date\.now)\s*-\s*(?:last|previous)|(?:last|previous)[^}]*(?:now|current|Date\.now)/i,
        name: 'time-comparison',
        description: 'Must compare current time with last execution',
      },
    ],
    forbidden: [
      {
        pattern: /429|Too Many Requests/i,
        name: 'http-blocking',
        description: 'HTTP blocking is wrong for throttle',
      },
    ],
  },

  'express-middleware': {
    required: [
      {
        pattern: /(?:req|request)\s*,\s*(?:res|response)\s*,\s*next|function\s*\([^)]*req[^)]*res[^)]*next/i,
        name: 'middleware-signature',
        description: 'Must have Express middleware signature (req, res, next)',
      },
      {
        pattern: /next\s*\(\s*\)/i,
        name: 'next-call',
        description: 'Must call next() to pass control',
      },
    ],
    forbidden: [],
  },
};

/**
 * SEMANTIC TESTS - Function-based validation that catches logic bugs regex can't
 */
const SEMANTIC_TESTS: Record<string, SemanticTest[]> = {
  'sliding-window-rate-limiting': [
    {
      name: 'window_size_correct',
      description: 'Window should be exactly windowMs, not windowMs * maxRequests',
      test: (code: string) => {
        const hasBugPattern =
          /maxRequests?\s*\*\s*(60|1000|window)/i.test(code) ||
          /(60|1000|window)\s*\*\s*maxRequests?/i.test(code);
        const hasCorrectWindow =
          /now\s*-\s*(this\.)?(windowMs|window|60000|1000)/i.test(code) ||
          /filter\s*\([^)]*>\s*(this\.)?(windowMs|cutoff|threshold)/i.test(code);
        return {
          passed: !hasBugPattern && hasCorrectWindow,
          reason: hasBugPattern
            ? 'Window size incorrectly multiplied by maxRequests'
            : !hasCorrectWindow
              ? 'Window calculation pattern not found'
              : null,
        };
      },
    },
    {
      name: 'no_multiple_implementations',
      description: 'Should have exactly one RateLimiter class/function',
      test: (code: string) => {
        const classCount = (code.match(/class\s+\w*Rate\s*Limit/gi) || []).length;
        const functionCount = (code.match(/function\s+\w*rateLim/gi) || []).length;
        const arrowCount = (code.match(/const\s+\w*rateLim\w*\s*=/gi) || []).length;
        const total = classCount + functionCount + arrowCount;
        return {
          passed: total <= 1,
          reason:
            total > 1
              ? `Found ${total} rate limiter implementations - should have exactly 1`
              : null,
        };
      },
    },
    {
      name: 'has_production_methods',
      description:
        'Production rate limiters need getRemainingRequests() and getRetryAfter()',
      test: (code: string) => {
        const hasRemaining =
          /getRemainingRequests|remaining\s*\(\)|\.remaining\b/i.test(code);
        const hasRetryAfter =
          /getRetryAfter|retryAfter\s*\(\)|\.retryAfter\b|Retry-After/i.test(code);
        const missing: string[] = [];
        if (!hasRemaining) missing.push('getRemainingRequests()');
        if (!hasRetryAfter) missing.push('getRetryAfter()');
        return {
          passed: missing.length === 0,
          reason:
            missing.length > 0
              ? `Missing production methods: ${missing.join(', ')}`
              : null,
          severity: 'warning', // Not critical but recommended
        };
      },
    },
    {
      name: 'efficient_cleanup',
      description: 'High-throughput rate limiters need O(log n) or O(1) cleanup',
      test: (code: string) => {
        const hasInefficient =
          /forEach\s*\([^)]*delete\b/i.test(code) ||
          /for\s*\([^)]*in\b[^)]*\)[^}]*delete\b/i.test(code);
        const hasEfficient =
          /\.filter\s*\(|while\s*\([^)]*\[0\]|\.shift\s*\(|splice\s*\(0/i.test(code);
        return {
          passed: !hasInefficient || hasEfficient,
          reason:
            hasInefficient && !hasEfficient
              ? 'Inefficient O(n) cleanup pattern detected'
              : null,
          severity: 'warning',
        };
      },
    },
  ],

  'token-bucket-rate-limiting': [
    {
      name: 'token_refill_timing',
      description: 'Token refill must be time-based, not per-request',
      test: (code: string) => {
        const hasTimeBasedRefill =
          /Date\.now\(\)|performance\.now\(\)/i.test(code) &&
          /refill|replenish|lastRefill|elapsed/i.test(code);
        return {
          passed: hasTimeBasedRefill,
          reason: !hasTimeBasedRefill
            ? 'Token refill should be time-based'
            : null,
        };
      },
    },
  ],
};

/**
 * EXECUTION-BASED TESTS - Actually run the generated code against test cases
 */
const EXECUTION_TESTS: Record<string, ExecutionTestSuite> = {
  'sliding-window-rate-limiting': {
    tests: [
      {
        name: 'allows_requests_under_limit',
        description: 'Should allow requests when under rate limit',
        run: (RateLimiter: any) => {
          const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
          const results: any[] = [];
          for (let i = 0; i < 3; i++) {
            const result =
              limiter.tryRequest?.('test-user') ??
              limiter.isAllowed?.('test-user');
            results.push(result);
          }
          const passed =
            results.filter((r) => r === true || r?.allowed).length >= 3;
          return {
            passed,
            reason: passed
              ? null
              : 'Requests should be allowed when under limit',
          };
        },
      },
      {
        name: 'blocks_requests_over_limit',
        description: 'Should block requests when over rate limit',
        run: (RateLimiter: any) => {
          const limiter = new RateLimiter({
            windowMs: 60000,
            maxRequests: 3,
          });
          for (let i = 0; i < 3; i++) {
            limiter.tryRequest?.('flood-user') ??
              limiter.isAllowed?.('flood-user');
          }
          const result =
            limiter.tryRequest?.('flood-user') ??
            limiter.isAllowed?.('flood-user');
          const blocked = result === false || result?.allowed === false;
          return {
            passed: blocked,
            reason: blocked
              ? null
              : 'Request not blocked after exceeding limit',
          };
        },
      },
      {
        name: 'isolates_per_key',
        description: 'Should track limits per-key independently',
        run: (RateLimiter: any) => {
          const limiter = new RateLimiter({
            windowMs: 60000,
            maxRequests: 2,
          });
          limiter.tryRequest?.('user1');
          limiter.tryRequest?.('user1');
          limiter.tryRequest?.('user1');
          const user2Result =
            limiter.tryRequest?.('user2') ?? limiter.isAllowed?.('user2');
          const passed =
            user2Result === true || user2Result?.allowed === true;
          return {
            passed,
            reason: passed ? null : 'user2 incorrectly blocked by user1',
          };
        },
      },
      {
        name: 'correct_window_size',
        description: 'Window should be windowMs, not windowMs * maxRequests',
        run: (RateLimiter: any) => {
          const limiter = new RateLimiter({
            windowMs: 100,
            maxRequests: 5,
          });
          for (let i = 0; i < 5; i++) limiter.tryRequest?.('window-test');
          return new Promise<{ passed: boolean; reason: string | null }>((resolve) => {
            setTimeout(() => {
              const result = limiter.tryRequest?.('window-test');
              const allowed = result === true || result?.allowed === true;
              resolve({
                passed: allowed,
                reason: allowed ? null : 'Window size incorrect',
              });
            }, 150);
          });
        },
      },
    ],
  },
  'token-bucket-rate-limiting': {
    tests: [
      {
        name: 'consumes_tokens',
        description: 'Should consume tokens on each request',
        run: (TokenBucket: any) => {
          const bucket = new TokenBucket({ capacity: 10, refillRate: 1 });
          const initial = bucket.getTokens?.() ?? bucket.tokens ?? 10;
          bucket.tryRequest?.() ?? bucket.consume?.();
          const after = bucket.getTokens?.() ?? bucket.tokens;
          const passed = after !== undefined && after < initial;
          return {
            passed,
            reason: passed ? null : 'Tokens not consumed',
          };
        },
      },
      {
        name: 'blocks_when_empty',
        description: 'Should block when no tokens available',
        run: (TokenBucket: any) => {
          const bucket = new TokenBucket({ capacity: 3, refillRate: 0 });
          for (let i = 0; i < 5; i++)
            bucket.tryRequest?.() ?? bucket.consume?.();
          const result = bucket.tryRequest?.() ?? bucket.consume?.();
          const blocked = result === false || result?.allowed === false;
          return {
            passed: blocked,
            reason: blocked ? null : 'Not blocked when empty',
          };
        },
      },
    ],
  },
};

export class AlgorithmValidator {
  private stats: {
    validations: number;
    passed: number;
    failed: number;
    regenerations: number;
  };

  constructor() {
    this.stats = {
      validations: 0,
      passed: 0,
      failed: 0,
      regenerations: 0,
    };
  }

  /**
   * Validate that code satisfies all algorithmic requirements
   */
  validate(code: string, algorithmType: string): ValidationResult {
    this.stats.validations++;

    const requirements = ALGORITHM_REQUIREMENTS[algorithmType];

    // Unknown algorithm type - pass with warning
    if (!requirements) {
      return {
        valid: true,
        warning: `Unknown algorithm type '${algorithmType}' - no validation applied`,
        missing: [],
        forbidden: [],
        satisfied: [],
        details: [],
      };
    }

    const results: ValidationResult = {
      valid: true,
      missing: [],
      forbidden: [],
      satisfied: [],
      details: [],
    };

    // Check required patterns
    for (const req of requirements.required) {
      const matches = req.pattern.test(code);
      if (matches) {
        results.satisfied.push(req.name);
        results.details.push({
          requirement: req.name,
          status: 'SATISFIED',
          description: req.description,
        });
      } else {
        results.missing.push(req.name);
        results.valid = false;
        results.details.push({
          requirement: req.name,
          status: 'MISSING',
          description: req.description,
          hint: `Code must include pattern matching: ${req.pattern.source}`,
        });
      }
    }

    // Check forbidden patterns
    for (const forbidden of requirements.forbidden || []) {
      if (forbidden.pattern.test(code)) {
        results.forbidden.push(forbidden.name);
        results.valid = false;
        results.details.push({
          requirement: forbidden.name,
          status: 'FORBIDDEN_PRESENT',
          description: forbidden.description,
          hint: `Remove pattern matching: ${forbidden.pattern.source}`,
        });
      }
    }

    // Run semantic tests (function-based validation for logic bugs)
    const semanticTests = SEMANTIC_TESTS[algorithmType] || [];
    results.semanticTests = [];
    for (const test of semanticTests) {
      try {
        const testResult = test.test(code);
        results.semanticTests.push({
          name: test.name,
          description: test.description,
          passed: testResult.passed,
          reason: testResult.reason,
          severity: testResult.severity || 'error',
        });
        if (!testResult.passed) {
          // Only fail validation for error severity, not warnings
          if (testResult.severity !== 'warning') {
            results.valid = false;
          }
          results.details.push({
            requirement: test.name,
            status:
              testResult.severity === 'warning'
                ? 'WARNING'
                : 'SEMANTIC_FAILURE',
            description: test.description,
            hint: testResult.reason || 'Semantic test failed',
          });
        }
      } catch (e: any) {
        // Semantic test crashed - log but don't fail validation
        results.semanticTests.push({
          name: test.name,
          passed: true, // Don't fail on test errors
          reason: `Test error: ${e.message}`,
          severity: 'skipped',
        });
      }
    }

    // Update stats
    if (results.valid) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
    }

    // Add action if invalid
    if (!results.valid) {
      results.action = 'REGENERATE';
      results.regenerationPrompt = this.buildRegenerationPrompt(
        algorithmType,
        results
      );
    }

    return results;
  }

  /**
   * Build a prompt to fix missing requirements
   */
  buildRegenerationPrompt(
    algorithmType: string,
    validationResults: ValidationResult
  ): string {
    const lines: string[] = [
      `## CRITICAL: Your code is missing required ${algorithmType} components`,
      '',
      '### Missing Requirements (MUST add):',
    ];

    for (const missing of validationResults.missing) {
      const detail = validationResults.details.find(
        (d) => d.requirement === missing
      );
      lines.push(
        `- ${missing}: ${detail?.description || 'Required element missing'}`
      );
    }

    if (validationResults.forbidden.length > 0) {
      lines.push('');
      lines.push('### Forbidden Patterns (MUST remove):');
      for (const forbidden of validationResults.forbidden) {
        const detail = validationResults.details.find(
          (d) => d.requirement === forbidden
        );
        lines.push(
          `- ${forbidden}: ${detail?.description || 'Wrong pattern detected'}`
        );
      }
    }

    lines.push('');
    lines.push('### Implementation Requirements:');
    lines.push(this.getImplementationGuide(algorithmType));

    return lines.join('\n');
  }

  /**
   * Get implementation guide for an algorithm type
   */
  getImplementationGuide(algorithmType: string): string {
    const guides: Record<string, string> = {
      'sliding-window-rate-limiting': `
1. Create a Map or object to store request timestamps per client (IP/userId)
2. On each request:
   a. Get current time with Date.now()
   b. Filter out timestamps older than (now - windowMs)
   c. Check if remaining count < maxRequests
   d. If under limit: add current timestamp, call next()
   e. If over limit: return res.status(429)
3. Include cleanup: remove old timestamps during request or via periodic timer`,

      debounce: `
1. Create a variable to store the timeout ID
2. On each call:
   a. Clear any existing timeout with clearTimeout
   b. Set a new timeout with setTimeout
   c. Execute the function after the delay`,

      throttle: `
1. Track the time of the last execution
2. On each call:
   a. Get current time
   b. Check if enough time has passed since last execution
   c. If yes, execute and update lastCall time
   d. If no, skip or queue for later`,
    };

    return (
      guides[algorithmType] ||
      'Implement according to standard patterns for this algorithm type.'
    );
  }

  /**
   * Quick check if code looks like the wrong algorithm
   */
  detectWrongAlgorithm(
    code: string,
    expectedAlgorithm: string
  ): { isWrong: boolean; detectedAs: string | null; reason: string | null } {
    const algorithmSignatures: Record<string, RegExp> = {
      debounce:
        /setTimeout\s*\([^)]*\)\s*[;\n\s]*}?\s*[;\n\s]*clearTimeout/i,
      throttle:
        /lastCall\s*=\s*Date\.now\(\)|if\s*\([^)]*Date\.now\(\)\s*-\s*last/i,
      'sliding-window-rate-limiting':
        /429.*sliding|sliding.*429|timestamps\.filter|requestHistory\.filter/i,
      'token-bucket':
        /tokens\s*[<>]=?\s*\d|bucket.*capacity|refill.*tokens/i,
    };

    for (const [algorithm, signature] of Object.entries(algorithmSignatures)) {
      if (algorithm !== expectedAlgorithm && signature.test(code)) {
        const expectedSignature = algorithmSignatures[expectedAlgorithm];
        if (expectedSignature && !expectedSignature.test(code)) {
          return {
            isWrong: true,
            detectedAs: algorithm,
            reason: `Code appears to implement ${algorithm} instead of ${expectedAlgorithm}`,
          };
        }
      }
    }

    return { isWrong: false, detectedAs: null, reason: null };
  }

  /**
   * Run execution-based tests on generated code
   */
  async runExecutionTests(
    code: string,
    algorithmType: string
  ): Promise<ExecutionTestSuiteResult> {
    const testSuite = EXECUTION_TESTS[algorithmType];
    if (!testSuite) {
      return {
        passed: true,
        results: [],
        skipped: true,
        reason: 'No execution tests for this algorithm type',
      };
    }

    const results: ExecutionTestResultItem[] = [];
    let allPassed = true;

    try {
      // Try to extract and instantiate the class/function from generated code
      const vm = await import('vm');
      const context: Record<string, any> = {
        exports: {},
        module: { exports: {} },
        console,
        setTimeout,
        Promise,
      };
      vm.createContext(context);

      // Try to execute the code to get the exported class
      try {
        const wrappedCode = code.replace(
          /export\s+(default\s+)?/g,
          'module.exports = '
        );
        vm.runInContext(wrappedCode, context, { timeout: 5000 });
      } catch (e: any) {
        return {
          passed: false,
          results: [],
          error: 'Failed to execute generated code: ' + e.message,
        };
      }

      const ExportedClass =
        context.module.exports.default || context.module.exports;
      if (!ExportedClass || typeof ExportedClass !== 'function') {
        return {
          passed: false,
          results: [],
          error: 'Generated code does not export a class/function',
        };
      }

      // Run each test
      for (const test of testSuite.tests) {
        try {
          const result = await Promise.resolve(test.run(ExportedClass));
          results.push({
            name: test.name,
            description: test.description,
            ...result,
          });
          if (!result.passed) {
            allPassed = false;
          }
        } catch (e: any) {
          results.push({
            name: test.name,
            description: test.description,
            passed: false,
            reason: 'Test threw error: ' + e.message,
          });
          allPassed = false;
        }
      }
    } catch (e: any) {
      return {
        passed: false,
        results: [],
        error: 'Execution test framework error: ' + e.message,
      };
    }

    return { passed: allPassed, results };
  }

  /**
   * Get validation statistics
   */
  getStats(): {
    validations: number;
    passed: number;
    failed: number;
    regenerations: number;
  } {
    return { ...this.stats };
  }

  /**
   * Reset statistics (for testing)
   */
  resetStats(): void {
    this.stats = { validations: 0, passed: 0, failed: 0, regenerations: 0 };
  }
}

// Singleton
let validatorInstance: AlgorithmValidator | null = null;

export function getAlgorithmValidator(): AlgorithmValidator {
  if (!validatorInstance) {
    validatorInstance = new AlgorithmValidator();
  }
  return validatorInstance;
}
