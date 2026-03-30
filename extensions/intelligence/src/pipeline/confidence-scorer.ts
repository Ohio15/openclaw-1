/**
 * Confidence Scoring System
 *
 * Scores AI response confidence to determine if retry/fallback is needed.
 * Uses multiple signals to assess response quality.
 *
 * Ported from AICodeAssistant ConfidenceScorer.js
 */

export interface ConfidenceSignalResult {
  passed: boolean;
  weight: number;
  name: string;
}

export interface ConfidenceResult {
  score: number;
  signals: Record<string, ConfidenceSignalResult>;
  recommendation: 'accept' | 'review' | 'retry';
  concerns: string[];
  explanation: string;
  thresholds: typeof THRESHOLDS;
}

export interface ComparisonResult {
  best: string;
  bestScore: number;
  scores: [number, number];
}

interface SignalConfig {
  weight: number;
  check: (r: string) => boolean;
  name: string;
}

/**
 * Confidence signals with weights
 */
const CONFIDENCE_SIGNALS: Record<string, SignalConfig> = {
  // Structure signals
  hasCodeBlock: {
    weight: 0.15,
    check: (r: string) => /```[\s\S]*?```/.test(r),
    name: 'Contains code block',
  },
  codeBlocksBalanced: {
    weight: 0.1,
    check: (r: string) => (r.match(/```/g) || []).length % 2 === 0,
    name: 'Code blocks balanced',
  },
  properLength: {
    weight: 0.1,
    check: (r: string) => r.length >= 200 && r.length <= 30000,
    name: 'Response length appropriate',
  },

  // Content quality signals
  hasTypeScript: {
    weight: 0.1,
    check: (r: string) => /: string|: number|interface \w+|type \w+ =|<\w+>/.test(r),
    name: 'Contains TypeScript types',
  },
  noPlaceholders: {
    weight: 0.1,
    check: (r: string) =>
      !/\b(TODO|FIXME|XXX)\b|implement this|your code here/i.test(r),
    name: 'No placeholder comments',
  },
  hasErrorHandling: {
    weight: 0.05,
    check: (r: string) => /try\s*{|catch\s*\(|throw new|\.catch\(/.test(r),
    name: 'Includes error handling',
  },
  hasExports: {
    weight: 0.05,
    check: (r: string) =>
      /export\s+(default\s+)?(function|class|const|interface)|module\.exports/.test(r),
    name: 'Has export statements',
  },

  // Format signals
  startsCleanly: {
    weight: 0.1,
    check: (r: string) => /^```|^import |^\/\*\*|^\/\//.test(r.trim()),
    name: 'Starts with code or comment',
  },
  endsCleanly: {
    weight: 0.05,
    check: (r: string) => /```\s*$|}\s*$|;\s*$/.test(r.trim()),
    name: 'Ends cleanly',
  },
  noTruncation: {
    weight: 0.1,
    check: (r: string) =>
      !r.endsWith('...') && !/\/\/\s*\.\.\.\s*$/.test(r) && !r.endsWith('etc'),
    name: 'Not truncated',
  },

  // Structural completeness
  hasMultipleBlocks: {
    weight: 0.05,
    check: (r: string) => (r.match(/```/g) || []).length >= 4,
    name: 'Multiple code blocks (explanation included)',
  },
  hasExplanation: {
    weight: 0.05,
    check: (r: string) => {
      const nonCodeParts = r.replace(/```[\s\S]*?```/g, '').trim();
      return nonCodeParts.length > 100;
    },
    name: 'Contains explanation text',
  },
};

/**
 * Confidence thresholds
 */
const THRESHOLDS = {
  high: 0.8, // Accept immediately
  medium: 0.6, // Consider review
  low: 0.4, // Retry recommended
} as const;

/**
 * Optional sandbox metadata for confidence scoring.
 * When present, sandbox-related signals are included in scoring.
 */
export interface SandboxMetadata {
  /** Whether all sandboxed tool executions succeeded */
  executionSucceeded: boolean;
  /** Number of security violations detected during sandbox execution */
  violationCount: number;
}

/**
 * Score confidence of a response
 */
export function scoreConfidence(
  response: string,
  _request: Record<string, unknown> = {},
  sandboxMetadata?: SandboxMetadata,
): ConfidenceResult {
  if (!response || typeof response !== 'string') {
    return {
      score: 0,
      signals: {},
      recommendation: 'retry',
      concerns: ['Empty or invalid response'],
      explanation: 'Response is empty or invalid',
      thresholds: THRESHOLDS,
    };
  }

  const signals: Record<string, ConfidenceSignalResult> = {};
  const concerns: string[] = [];
  let totalWeight = 0;
  let weightedScore = 0;

  // Evaluate each signal
  for (const [signalName, config] of Object.entries(CONFIDENCE_SIGNALS)) {
    const passed = config.check(response);
    signals[signalName] = {
      passed,
      weight: config.weight,
      name: config.name,
    };

    totalWeight += config.weight;
    if (passed) {
      weightedScore += config.weight;
    } else {
      concerns.push(config.name);
    }
  }

  // Sandbox-specific signals (only when sandbox metadata is present)
  if (sandboxMetadata) {
    const sandboxSignals: Record<string, { weight: number; name: string; passed: boolean }> = {
      sandboxExecutionSucceeded: {
        weight: 0.1,
        name: 'Sandbox execution succeeded',
        passed: sandboxMetadata.executionSucceeded,
      },
      noSandboxViolations: {
        weight: 0.05,
        name: 'No sandbox violations',
        passed: sandboxMetadata.violationCount === 0,
      },
    };

    for (const [signalName, signal] of Object.entries(sandboxSignals)) {
      signals[signalName] = {
        passed: signal.passed,
        weight: signal.weight,
        name: signal.name,
      };

      totalWeight += signal.weight;
      if (signal.passed) {
        weightedScore += signal.weight;
      } else {
        concerns.push(signal.name);
      }
    }
  }

  // Normalize score
  const score = weightedScore / totalWeight;

  // Determine recommendation
  let recommendation: 'accept' | 'review' | 'retry';
  let explanation: string;

  if (score >= THRESHOLDS.high) {
    recommendation = 'accept';
    explanation = `High confidence (${(score * 100).toFixed(0)}%): Response meets quality standards`;
  } else if (score >= THRESHOLDS.medium) {
    recommendation = 'review';
    explanation = `Medium confidence (${(score * 100).toFixed(0)}%): Consider reviewing before accepting`;
  } else if (score >= THRESHOLDS.low) {
    recommendation = 'retry';
    explanation = `Low confidence (${(score * 100).toFixed(0)}%): Retry recommended`;
  } else {
    recommendation = 'retry';
    explanation = `Very low confidence (${(score * 100).toFixed(0)}%): Retry with different approach`;
  }

  return {
    score,
    signals,
    recommendation,
    concerns: concerns.slice(0, 5), // Top 5 concerns
    explanation,
    thresholds: THRESHOLDS,
  };
}

/**
 * Check if retry is recommended
 */
export function shouldRetry(score: number): boolean {
  return score < THRESHOLDS.medium;
}

/**
 * Check if review is recommended
 */
export function shouldReview(score: number): boolean {
  return score >= THRESHOLDS.low && score < THRESHOLDS.high;
}

/**
 * Get confidence level label
 */
export function getConfidenceLevel(
  score: number
): 'high' | 'medium' | 'low' | 'very_low' {
  if (score >= THRESHOLDS.high) return 'high';
  if (score >= THRESHOLDS.medium) return 'medium';
  if (score >= THRESHOLDS.low) return 'low';
  return 'very_low';
}

/**
 * Compare two responses and return the better one
 */
export function compareBest(
  response1: string,
  response2: string
): ComparisonResult {
  const score1 = scoreConfidence(response1);
  const score2 = scoreConfidence(response2);

  return {
    best: score1.score >= score2.score ? response1 : response2,
    bestScore: Math.max(score1.score, score2.score),
    scores: [score1.score, score2.score],
  };
}

export interface ConfidenceScorerInstance {
  score: typeof scoreConfidence;
  shouldRetry: typeof shouldRetry;
  shouldReview: typeof shouldReview;
  getLevel: typeof getConfidenceLevel;
  compare: typeof compareBest;
  THRESHOLDS: typeof THRESHOLDS;
}

// Singleton
let scorerInstance: ConfidenceScorerInstance | null = null;

export function getConfidenceScorer(): ConfidenceScorerInstance {
  if (!scorerInstance) {
    scorerInstance = {
      score: scoreConfidence,
      shouldRetry,
      shouldReview,
      getLevel: getConfidenceLevel,
      compare: compareBest,
      THRESHOLDS,
    };
  }
  return scorerInstance;
}

export { THRESHOLDS };
