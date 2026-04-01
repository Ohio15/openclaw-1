/**
 * Complexity Decomposer
 *
 * Analyzes request complexity using keyword-weighted heuristics.
 * Used by the control plane for tier routing and pipeline selection.
 *
 * @module complexity-decomposer
 */

export interface ComplexityAnalysis {
  complexity: number;
  featureCount: number;
  wordCount: number;
  indicators: DetectedIndicator[];
  needsDecomposition: boolean;
}

export interface DetectedIndicator {
  indicator: string;
  matches: string[];
  weight: number;
}

interface ComplexityIndicatorConfig {
  pattern: RegExp;
  weight: number;
}

/**
 * Complexity indicators with weights
 */
const COMPLEXITY_INDICATORS: Record<string, ComplexityIndicatorConfig> = {
  // Technical scope
  multipleEndpoints: { pattern: /\b(multiple|several|various)\s*(endpoints?|routes?|apis?)/i, weight: 0.15 },
  realtime: { pattern: /\b(real-?time|websocket|socket\.?io|live\s*update)/i, weight: 0.2 },
  authentication: { pattern: /\b(auth|jwt|oauth|session|login|permission)/i, weight: 0.15 },
  database: { pattern: /\b(database|postgres|mongodb|prisma|sql|orm)/i, weight: 0.1 },
  testing: { pattern: /\b(unit\s*test|test\s*case|jest|vitest|spec)/i, weight: 0.1 },

  // Algorithm complexity
  algorithms: { pattern: /\b(algorithm|crdt|ot|operational\s*transform|conflict\s*resolution)/i, weight: 0.25 },
  optimization: { pattern: /\b(optimi[sz]|performance|caching|rate\s*limit)/i, weight: 0.1 },

  // Scale indicators
  production: { pattern: /\b(production|prod-?ready|scalab|enterprise)/i, weight: 0.15 },
  comprehensive: { pattern: /\b(comprehensive|complete|full|entire)/i, weight: 0.1 },

  // Feature count
  multipleFeatures: { pattern: /\d+\.\s*\*\*|^\s*-\s*\w/gm, weight: 0.05 },
};

/**
 * Analyze request complexity
 */
export function analyzeComplexity(request: string): ComplexityAnalysis {
  let totalWeight = 0;
  let maxWeight = 0;
  const detectedIndicators: DetectedIndicator[] = [];

  for (const [name, { pattern, weight }] of Object.entries(COMPLEXITY_INDICATORS)) {
    const matches = request.match(pattern);
    if (matches) {
      // For counting patterns, weight by count
      const count = name === 'multipleFeatures' ? Math.min(matches.length, 10) : 1;
      const effectiveWeight = weight * count;

      totalWeight += effectiveWeight;
      maxWeight += weight * (name === 'multipleFeatures' ? 10 : 1);

      detectedIndicators.push({
        indicator: name,
        matches: matches.slice(0, 3),
        weight: effectiveWeight,
      });
    } else {
      maxWeight += weight;
    }
  }

  // Count bullet points and numbered items as feature count
  const featureCount =
    (request.match(/^\s*[-*]\s+\w/gm) || []).length +
    (request.match(/^\s*\d+\.\s+/gm) || []).length;

  // Estimate word count for request size
  const wordCount = request.split(/\s+/).length;

  const complexity = Math.min(1, totalWeight / (maxWeight * 0.5));

  return {
    complexity,
    featureCount,
    wordCount,
    indicators: detectedIndicators,
    needsDecomposition: complexity > 0.4 || featureCount > 3,
  };
}
