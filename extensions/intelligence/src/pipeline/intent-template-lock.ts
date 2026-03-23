/**
 * IntentTemplateLock - Strict binding between intents and allowed templates
 *
 * ARCHITECTURAL ROLE: INTENT-TEMPLATE GATE
 * - Prevents wrong templates from being used for an intent
 * - Explicitly forbids cross-contamination (e.g., debounce templates for rate-limiting)
 * - Aborts generation if forbidden template detected
 *
 * Ported from AICodeAssistant IntentTemplateLock.js
 */

export interface TemplateValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  action?: string;
  allowedTemplates?: string[];
}

export interface CodeValidationResult {
  valid: boolean;
  violations: string[];
  action?: string;
}

export interface LockViolation {
  timestamp: number;
  intent: string;
  template: string;
  forbidden: string;
  action: string;
}

interface IntentTemplateConfig {
  allowed: string[];
  forbidden: string[];
  keywords: string[];
}

/**
 * Mapping of intents to allowed and forbidden templates
 */
const INTENT_TEMPLATE_MAP: Record<string, IntentTemplateConfig> = {
  'rate-limiting': {
    allowed: [
      'sliding-window',
      'token-bucket',
      'fixed-window',
      'leaky-bucket',
      'express-rate-limit',
      'rate-limiter-flexible',
    ],
    forbidden: [
      'debounce',
      'throttle',
      'memoization',
      'cache',
      'leading-debounce',
      'trailing-debounce',
    ],
    keywords: ['rate', 'limit', '429', 'requests', 'window', 'bucket'],
  },

  'sliding-window-rate-limiting': {
    allowed: [
      'sliding-window',
      'timestamp-tracking',
      'request-history',
    ],
    forbidden: [
      'debounce',
      'throttle',
      'setTimeout',
      'clearTimeout',
      'fixed-window', // Different algorithm
      'token-bucket', // Different algorithm
    ],
    keywords: ['sliding', 'window', 'timestamps', 'history', 'filter'],
  },

  debounce: {
    allowed: [
      'debounce',
      'trailing-debounce',
      'leading-debounce',
      'lodash-debounce',
    ],
    forbidden: [
      'rate-limiting',
      'sliding-window',
      'token-bucket',
      'fixed-window',
      '429',
      'http-status',
    ],
    keywords: ['delay', 'wait', 'timeout', 'cancel'],
  },

  throttle: {
    allowed: [
      'throttle',
      'leading-throttle',
      'trailing-throttle',
      'lodash-throttle',
    ],
    forbidden: [
      'debounce',
      'rate-limiting',
      '429',
    ],
    keywords: ['throttle', 'interval', 'last-call'],
  },

  caching: {
    allowed: [
      'lru-cache',
      'ttl-cache',
      'memoization',
      'redis-cache',
      'memory-cache',
    ],
    forbidden: [
      'rate-limiting',
      '429',
    ],
    keywords: ['cache', 'memoize', 'store', 'ttl'],
  },

  middleware: {
    allowed: [
      'express-middleware',
      'koa-middleware',
      'fastify-plugin',
    ],
    forbidden: [],
    keywords: ['req', 'res', 'next', 'middleware'],
  },
};

export class IntentTemplateLock {
  private lockViolations: LockViolation[];
  private stats: {
    validations: number;
    violations: number;
    aborts: number;
  };

  constructor() {
    this.lockViolations = [];
    this.stats = {
      validations: 0,
      violations: 0,
      aborts: 0,
    };
  }

  /**
   * Validate that a template is allowed for the given intent
   */
  validateTemplateForIntent(
    intent: string,
    templateId: string
  ): TemplateValidationResult {
    this.stats.validations++;

    const config = INTENT_TEMPLATE_MAP[intent];

    // Unknown intent - allow but warn
    if (!config) {
      return {
        valid: true,
        warning: `Unknown intent '${intent}' - no template lock applied`,
      };
    }

    const templateLower = templateId.toLowerCase();

    // Check forbidden list first (higher priority)
    for (const forbidden of config.forbidden) {
      if (templateLower.includes(forbidden.toLowerCase())) {
        this.stats.violations++;
        this.lockViolations.push({
          timestamp: Date.now(),
          intent,
          template: templateId,
          forbidden,
          action: 'ABORT_AND_REGENERATE',
        });

        return {
          valid: false,
          error: `Template '${templateId}' contains forbidden pattern '${forbidden}' for intent '${intent}'`,
          action: 'ABORT_AND_REGENERATE',
        };
      }
    }

    // Check if in allowed list (if list is defined and non-empty)
    if (config.allowed.length > 0) {
      const isAllowed = config.allowed.some((allowed) =>
        templateLower.includes(allowed.toLowerCase())
      );

      if (!isAllowed) {
        this.stats.violations++;
        return {
          valid: false,
          error: `Template '${templateId}' not in allowed list for intent '${intent}'`,
          action: 'ABORT_AND_REGENERATE',
          allowedTemplates: config.allowed,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate code content against intent-forbidden patterns
   */
  validateCodeForIntent(intent: string, code: string): CodeValidationResult {
    const config = INTENT_TEMPLATE_MAP[intent];
    if (!config) {
      return { valid: true, violations: [] };
    }

    const violations: string[] = [];

    // Check for forbidden patterns in the code
    for (const forbidden of config.forbidden) {
      const pattern = new RegExp(forbidden, 'gi');
      if (pattern.test(code)) {
        violations.push(
          `Code contains forbidden pattern '${forbidden}' for intent '${intent}'`
        );
      }
    }

    if (violations.length > 0) {
      this.stats.violations++;
      return {
        valid: false,
        violations,
        action: 'REGENERATE',
      };
    }

    return { valid: true, violations: [] };
  }

  /**
   * Get requirements for a specific intent
   */
  getRequirementsForIntent(intent: string): string[] {
    const requirements: Record<string, string[]> = {
      'rate-limiting': [
        'Request tracking mechanism',
        'Time window enforcement',
        'Request count limiting',
        'HTTP 429 response on limit exceeded',
        'Cleanup of stale entries',
      ],
      'sliding-window-rate-limiting': [
        'Per-request timestamp tracking (array/list)',
        'Filter requests within (now - windowMs)',
        'Check request count against maxRequests',
        'Return 429 when limit exceeded',
        'Automatic cleanup of expired timestamps',
      ],
      debounce: [
        'setTimeout for delayed execution',
        'clearTimeout to cancel pending',
        'Timer reference variable',
        'Optional leading/trailing modes',
      ],
      throttle: [
        'Time tracking for last execution',
        'Interval enforcement',
        'Optional leading/trailing execution',
      ],
    };

    return requirements[intent] || [];
  }

  /**
   * Get keywords that should be present for an intent
   */
  getExpectedKeywords(intent: string): string[] {
    return INTENT_TEMPLATE_MAP[intent]?.keywords || [];
  }

  /**
   * Get forbidden keywords for an intent
   */
  getForbiddenKeywords(intent: string): string[] {
    return INTENT_TEMPLATE_MAP[intent]?.forbidden || [];
  }

  /**
   * Get lock violation history
   */
  getViolations(): LockViolation[] {
    return [...this.lockViolations];
  }

  /**
   * Get statistics
   */
  getStats(): { validations: number; violations: number; aborts: number } {
    return { ...this.stats };
  }

  /**
   * Clear violation history (for testing)
   */
  clearViolations(): void {
    this.lockViolations = [];
    this.stats = { validations: 0, violations: 0, aborts: 0 };
  }
}

// Singleton
let lockInstance: IntentTemplateLock | null = null;

export function getIntentTemplateLock(): IntentTemplateLock {
  if (!lockInstance) {
    lockInstance = new IntentTemplateLock();
  }
  return lockInstance;
}
