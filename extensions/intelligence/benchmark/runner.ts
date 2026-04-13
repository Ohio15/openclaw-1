/**
 * Benchmark Runner for Intelligence Pipeline Routing
 *
 * Evaluates the current complexity-decomposer + routing-authority heuristics
 * against a labeled dataset of 100 prompts with expected tier and pipeline
 * classifications.
 *
 * Usage:
 *   pnpm --filter ./extensions/intelligence exec tsx benchmark/runner.ts
 *
 * Options:
 *   --category <name>   Only run entries matching this category
 *   --verbose           Print every entry's predicted vs expected values
 *   --json              Output raw results JSON to stdout (skip human-readable report)
 *
 * @module benchmark/runner
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolve as pathResolve, dirname as pathDirname } from "node:path";

import { analyzeComplexity } from "../src/pipeline/complexity-decomposer.js";
import {
  selectTier,
  selectPipeline,
} from "../src/config/routing-authority.js";
import {
  detectDomain,
} from "../src/pipeline/control-plane.js";
import { LearnedClassifier } from "../src/pipeline/learned-classifier.js";

// ============================================================================
// Types
// ============================================================================

interface BenchmarkEntry {
  id: string;
  prompt: string;
  category: string;
  domain: string | null;
  expectedTier: string;
  expectedPipeline: string;
  qualityCriteria: string[];
  antiPatterns: string[];
  tags: string[];
}

interface EntryResult {
  id: string;
  category: string;
  domain: string | null;
  expectedTier: string;
  predictedTier: string;
  tierCorrect: boolean;
  expectedPipeline: string;
  predictedPipeline: string;
  pipelineCorrect: boolean;
  complexity: number;
  detectedDomain: string | null;
  tierReason: string;
  pipelineReason: string;
  // Learned classifier results (null if model not available)
  classifierTier: string | null;
  classifierPipeline: string | null;
  classifierTierCorrect: boolean | null;
  classifierPipelineCorrect: boolean | null;
  classifierTierConfidence: number | null;
  classifierPipelineConfidence: number | null;
}

interface ConfusionCell {
  count: number;
  ids: string[];
}

interface CategoryMetrics {
  total: number;
  tierCorrect: number;
  pipelineCorrect: number;
  tierAccuracy: number;
  pipelineAccuracy: number;
}

interface BenchmarkResults {
  timestamp: string;
  totalEntries: number;
  // Heuristic results
  tierAccuracy: number;
  pipelineAccuracy: number;
  categoryBreakdown: Record<string, CategoryMetrics>;
  tierConfusionMatrix: Record<string, Record<string, ConfusionCell>>;
  pipelineConfusionMatrix: Record<string, Record<string, ConfusionCell>>;
  // Classifier results (null if model not available)
  classifierAvailable: boolean;
  classifierTierAccuracy: number | null;
  classifierPipelineAccuracy: number | null;
  classifierCategoryBreakdown: Record<string, CategoryMetrics> | null;
  classifierTierConfusionMatrix: Record<string, Record<string, ConfusionCell>> | null;
  classifierPipelineConfusionMatrix: Record<string, Record<string, ConfusionCell>> | null;
  entries: EntryResult[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect task type from text — mirrors control-plane.ts detectTaskType.
 * Reproduced here to avoid importing a private function.
 */
function detectTaskType(text: string): string {
  const lower = text.toLowerCase();

  if (/```|function\s|class\s|def\s|import\s|const\s|let\s|var\s/.test(text)) return "code_generation";
  if (/\b(error|exception|bug|fix|debug|traceback|stack)\b/.test(lower)) return "debugging";
  if (/\b(refactor|restructure|clean up|simplify)\b/.test(lower)) return "refactoring";
  if (/\b(explain|what is|how does|why does|describe)\b/.test(lower)) return "code_explanation";
  if (/\b(test|spec|assertion|mock|stub)\b/.test(lower)) return "testing";
  if (/\b(document|jsdoc|readme|comment)\b/.test(lower)) return "documentation";
  if (/\b(review|audit|check|inspect)\b/.test(lower)) return "code_review";

  return "general";
}

/**
 * Count requirements — mirrors control-plane.ts countRequirements.
 */
function countRequirements(text: string): number {
  let count = 0;
  const listItems = text.match(/^[\s]*[-*•]\s+.+$/gm);
  if (listItems) count += listItems.length;
  const numberedItems = text.match(/^[\s]*\d+[.)]\s+.+$/gm);
  if (numberedItems) count += numberedItems.length;
  const mustStatements = text.match(/\b(must|should|need to|require|ensure)\b/gi);
  if (mustStatements) count += Math.ceil(mustStatements.length / 2);
  return count;
}

function buildConfusionMatrix(
  entries: EntryResult[],
  getExpected: (e: EntryResult) => string,
  getPredicted: (e: EntryResult) => string,
): Record<string, Record<string, ConfusionCell>> {
  const labels = new Set<string>();
  for (const entry of entries) {
    labels.add(getExpected(entry));
    labels.add(getPredicted(entry));
  }

  const matrix: Record<string, Record<string, ConfusionCell>> = {};
  for (const expected of labels) {
    matrix[expected] = {};
    for (const predicted of labels) {
      matrix[expected][predicted] = { count: 0, ids: [] };
    }
  }

  for (const entry of entries) {
    const expected = getExpected(entry);
    const predicted = getPredicted(entry);
    if (!matrix[expected][predicted]) {
      matrix[expected][predicted] = { count: 0, ids: [] };
    }
    matrix[expected][predicted].count++;
    matrix[expected][predicted].ids.push(entry.id);
  }

  return matrix;
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ============================================================================
// Main
// ============================================================================

function run(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const suitePath = resolve(__dirname, "suite.json");
  const resultsPath = resolve(__dirname, "results.json");

  // Parse CLI args
  const args = process.argv.slice(2);
  const categoryFilter = args.includes("--category")
    ? args[args.indexOf("--category") + 1]
    : null;
  const verbose = args.includes("--verbose");
  const jsonOnly = args.includes("--json");

  // Load suite
  const raw = readFileSync(suitePath, "utf-8");
  let suite: BenchmarkEntry[] = JSON.parse(raw);

  if (categoryFilter) {
    suite = suite.filter((e) => e.category === categoryFilter);
    if (!jsonOnly) {
      console.log(`Filtering to category: ${categoryFilter} (${suite.length} entries)\n`);
    }
  }

  if (suite.length === 0) {
    console.error("No entries to evaluate.");
    process.exit(1);
  }

  // Load learned classifier (if model file exists)
  const classifier = new LearnedClassifier();
  const classifierModelPath = pathResolve(__dirname, "classifier-model.json");
  const classifierAvailable = classifier.loadModelFromFile(classifierModelPath);

  if (!jsonOnly) {
    console.log(
      classifierAvailable
        ? `Learned classifier model loaded from: ${classifierModelPath}`
        : "Learned classifier model NOT found — running heuristic only",
    );
    console.log("");
  }

  // Evaluate each entry
  const entryResults: EntryResult[] = [];

  for (const entry of suite) {
    const complexityResult = analyzeComplexity(entry.prompt);
    const domain = detectDomain(entry.prompt);
    const taskType = detectTaskType(entry.prompt);
    const requirementCount = countRequirements(entry.prompt);

    const tierSelection = selectTier(complexityResult.complexity, domain, taskType);
    const pipelineSelection = selectPipeline(
      complexityResult.complexity,
      requirementCount,
      entry.prompt,
    );

    // Classifier prediction (if available)
    let classifierTier: string | null = null;
    let classifierPipeline: string | null = null;
    let classifierTierConfidence: number | null = null;
    let classifierPipelineConfidence: number | null = null;

    if (classifierAvailable) {
      const prediction = classifier.predictFromPrompt(entry.prompt);
      classifierTier = prediction.tier;
      classifierPipeline = prediction.pipeline;
      classifierTierConfidence = prediction.tierConfidence;
      classifierPipelineConfidence = prediction.pipelineConfidence;
    }

    const result: EntryResult = {
      id: entry.id,
      category: entry.category,
      domain: entry.domain,
      expectedTier: entry.expectedTier,
      predictedTier: tierSelection.tier,
      tierCorrect: tierSelection.tier === entry.expectedTier,
      expectedPipeline: entry.expectedPipeline,
      predictedPipeline: pipelineSelection.pipeline,
      pipelineCorrect: pipelineSelection.pipeline === entry.expectedPipeline,
      complexity: complexityResult.complexity,
      detectedDomain: domain,
      tierReason: tierSelection.reason,
      pipelineReason: pipelineSelection.reason,
      classifierTier,
      classifierPipeline,
      classifierTierCorrect: classifierTier !== null ? classifierTier === entry.expectedTier : null,
      classifierPipelineCorrect: classifierPipeline !== null ? classifierPipeline === entry.expectedPipeline : null,
      classifierTierConfidence,
      classifierPipelineConfidence,
    };

    entryResults.push(result);

    if (verbose && !jsonOnly) {
      const tierMark = result.tierCorrect ? "OK" : "MISS";
      const pipeMark = result.pipelineCorrect ? "OK" : "MISS";
      let line =
        `${result.id} [${result.category}] ` +
        `tier: ${result.expectedTier} -> ${result.predictedTier} (${tierMark}) | ` +
        `pipe: ${result.expectedPipeline} -> ${result.predictedPipeline} (${pipeMark}) | ` +
        `complexity: ${result.complexity.toFixed(3)} | domain: ${result.detectedDomain ?? "none"}`;

      if (classifierAvailable) {
        const cTierMark = result.classifierTierCorrect ? "OK" : "MISS";
        const cPipeMark = result.classifierPipelineCorrect ? "OK" : "MISS";
        line += ` | clf_tier: ${classifierTier} (${cTierMark}) | clf_pipe: ${classifierPipeline} (${cPipeMark})`;
      }

      console.log(line);
    }
  }

  // Aggregate metrics
  const totalEntries = entryResults.length;
  const tierCorrectCount = entryResults.filter((e) => e.tierCorrect).length;
  const pipelineCorrectCount = entryResults.filter((e) => e.pipelineCorrect).length;

  // Category breakdown
  const categories = [...new Set(entryResults.map((e) => e.category))];
  const categoryBreakdown: Record<string, CategoryMetrics> = {};

  for (const cat of categories) {
    const catEntries = entryResults.filter((e) => e.category === cat);
    const catTierCorrect = catEntries.filter((e) => e.tierCorrect).length;
    const catPipeCorrect = catEntries.filter((e) => e.pipelineCorrect).length;
    categoryBreakdown[cat] = {
      total: catEntries.length,
      tierCorrect: catTierCorrect,
      pipelineCorrect: catPipeCorrect,
      tierAccuracy: catTierCorrect / catEntries.length,
      pipelineAccuracy: catPipeCorrect / catEntries.length,
    };
  }

  // Confusion matrices
  const tierConfusion = buildConfusionMatrix(
    entryResults,
    (e) => e.expectedTier,
    (e) => e.predictedTier,
  );

  const pipelineConfusion = buildConfusionMatrix(
    entryResults,
    (e) => e.expectedPipeline,
    (e) => e.predictedPipeline,
  );

  // Classifier aggregate metrics (if available)
  let classifierTierAccuracy: number | null = null;
  let classifierPipelineAccuracy: number | null = null;
  let classifierCategoryBreakdown: Record<string, CategoryMetrics> | null = null;
  let classifierTierConfusion: Record<string, Record<string, ConfusionCell>> | null = null;
  let classifierPipelineConfusion: Record<string, Record<string, ConfusionCell>> | null = null;

  if (classifierAvailable) {
    const clfTierCorrectCount = entryResults.filter((e) => e.classifierTierCorrect).length;
    const clfPipelineCorrectCount = entryResults.filter((e) => e.classifierPipelineCorrect).length;
    classifierTierAccuracy = clfTierCorrectCount / totalEntries;
    classifierPipelineAccuracy = clfPipelineCorrectCount / totalEntries;

    classifierCategoryBreakdown = {};
    for (const cat of categories) {
      const catEntries = entryResults.filter((e) => e.category === cat);
      const catTierCorrect = catEntries.filter((e) => e.classifierTierCorrect).length;
      const catPipeCorrect = catEntries.filter((e) => e.classifierPipelineCorrect).length;
      classifierCategoryBreakdown[cat] = {
        total: catEntries.length,
        tierCorrect: catTierCorrect,
        pipelineCorrect: catPipeCorrect,
        tierAccuracy: catTierCorrect / catEntries.length,
        pipelineAccuracy: catPipeCorrect / catEntries.length,
      };
    }

    classifierTierConfusion = buildConfusionMatrix(
      entryResults,
      (e) => e.expectedTier,
      (e) => e.classifierTier ?? "unknown",
    );

    classifierPipelineConfusion = buildConfusionMatrix(
      entryResults,
      (e) => e.expectedPipeline,
      (e) => e.classifierPipeline ?? "unknown",
    );
  }

  // Build results
  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    totalEntries,
    tierAccuracy: tierCorrectCount / totalEntries,
    pipelineAccuracy: pipelineCorrectCount / totalEntries,
    categoryBreakdown,
    tierConfusionMatrix: tierConfusion,
    pipelineConfusionMatrix: pipelineConfusion,
    classifierAvailable,
    classifierTierAccuracy,
    classifierPipelineAccuracy,
    classifierCategoryBreakdown,
    classifierTierConfusionMatrix: classifierTierConfusion,
    classifierPipelineConfusionMatrix: classifierPipelineConfusion,
    entries: entryResults,
  };

  // Write results file
  writeFileSync(resultsPath, JSON.stringify(results, null, 2), "utf-8");

  if (jsonOnly) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Human-readable report
  console.log("=".repeat(70));
  console.log("  BENCHMARK RESULTS — Intelligence Pipeline Routing");
  console.log("=".repeat(70));
  console.log(`  Timestamp:          ${results.timestamp}`);
  console.log(`  Total entries:      ${totalEntries}`);
  console.log(`  Tier accuracy:      ${formatPercent(results.tierAccuracy)} (${tierCorrectCount}/${totalEntries})`);
  console.log(`  Pipeline accuracy:  ${formatPercent(results.pipelineAccuracy)} (${pipelineCorrectCount}/${totalEntries})`);
  console.log("");

  // Category breakdown
  console.log("  Category Breakdown:");
  console.log("  " + "-".repeat(66));
  console.log(
    "  " +
    "Category".padEnd(14) +
    "Count".padEnd(8) +
    "Tier Acc".padEnd(12) +
    "Pipe Acc".padEnd(12) +
    "Tier OK".padEnd(10) +
    "Pipe OK",
  );
  console.log("  " + "-".repeat(66));

  for (const [cat, metrics] of Object.entries(categoryBreakdown)) {
    console.log(
      "  " +
      cat.padEnd(14) +
      String(metrics.total).padEnd(8) +
      formatPercent(metrics.tierAccuracy).padEnd(12) +
      formatPercent(metrics.pipelineAccuracy).padEnd(12) +
      `${metrics.tierCorrect}/${metrics.total}`.padEnd(10) +
      `${metrics.pipelineCorrect}/${metrics.total}`,
    );
  }
  console.log("");

  // Tier confusion matrix
  const tierLabels = Object.keys(tierConfusion).sort();
  console.log("  Tier Confusion Matrix (rows=expected, cols=predicted):");
  console.log("  " + "-".repeat(66));
  console.log("  " + "".padEnd(12) + tierLabels.map((l) => l.padEnd(10)).join(""));
  for (const expected of tierLabels) {
    const row = tierLabels.map((predicted) => {
      const cell = tierConfusion[expected]?.[predicted];
      return String(cell?.count ?? 0).padEnd(10);
    }).join("");
    console.log("  " + expected.padEnd(12) + row);
  }
  console.log("");

  // Pipeline confusion matrix
  const pipeLabels = Object.keys(pipelineConfusion).sort();
  console.log("  Pipeline Confusion Matrix (rows=expected, cols=predicted):");
  console.log("  " + "-".repeat(66));
  console.log("  " + "".padEnd(12) + pipeLabels.map((l) => l.padEnd(10)).join(""));
  for (const expected of pipeLabels) {
    const row = pipeLabels.map((predicted) => {
      const cell = pipelineConfusion[expected]?.[predicted];
      return String(cell?.count ?? 0).padEnd(10);
    }).join("");
    console.log("  " + expected.padEnd(12) + row);
  }
  console.log("");

  // Classifier results (side-by-side)
  if (classifierAvailable && classifierTierAccuracy !== null && classifierPipelineAccuracy !== null) {
    console.log("  " + "=".repeat(66));
    console.log("  LEARNED CLASSIFIER RESULTS");
    console.log("  " + "=".repeat(66));
    console.log(`  Classifier tier accuracy:      ${formatPercent(classifierTierAccuracy)} (${entryResults.filter((e) => e.classifierTierCorrect).length}/${totalEntries})`);
    console.log(`  Classifier pipeline accuracy:  ${formatPercent(classifierPipelineAccuracy)} (${entryResults.filter((e) => e.classifierPipelineCorrect).length}/${totalEntries})`);
    console.log("");

    // Side-by-side comparison
    console.log("  COMPARISON: Heuristic vs Classifier");
    console.log("  " + "-".repeat(66));
    console.log(
      "  " +
      "Metric".padEnd(25) +
      "Heuristic".padEnd(15) +
      "Classifier".padEnd(15) +
      "Delta",
    );
    console.log("  " + "-".repeat(66));
    const tierDelta = classifierTierAccuracy - results.tierAccuracy;
    const pipeDelta = classifierPipelineAccuracy - results.pipelineAccuracy;
    console.log(
      "  " +
      "Tier Accuracy".padEnd(25) +
      formatPercent(results.tierAccuracy).padEnd(15) +
      formatPercent(classifierTierAccuracy).padEnd(15) +
      `${tierDelta >= 0 ? "+" : ""}${formatPercent(tierDelta)}`,
    );
    console.log(
      "  " +
      "Pipeline Accuracy".padEnd(25) +
      formatPercent(results.pipelineAccuracy).padEnd(15) +
      formatPercent(classifierPipelineAccuracy).padEnd(15) +
      `${pipeDelta >= 0 ? "+" : ""}${formatPercent(pipeDelta)}`,
    );
    console.log("");

    // Classifier category breakdown
    if (classifierCategoryBreakdown) {
      console.log("  Classifier Category Breakdown:");
      console.log("  " + "-".repeat(66));
      console.log(
        "  " +
        "Category".padEnd(14) +
        "Count".padEnd(8) +
        "Tier Acc".padEnd(12) +
        "Pipe Acc".padEnd(12) +
        "Tier OK".padEnd(10) +
        "Pipe OK",
      );
      console.log("  " + "-".repeat(66));
      for (const [cat, metrics] of Object.entries(classifierCategoryBreakdown)) {
        console.log(
          "  " +
          cat.padEnd(14) +
          String(metrics.total).padEnd(8) +
          formatPercent(metrics.tierAccuracy).padEnd(12) +
          formatPercent(metrics.pipelineAccuracy).padEnd(12) +
          `${metrics.tierCorrect}/${metrics.total}`.padEnd(10) +
          `${metrics.pipelineCorrect}/${metrics.total}`,
        );
      }
      console.log("");
    }

    // Classifier tier confusion matrix
    if (classifierTierConfusion) {
      const clfTierLabels = Object.keys(classifierTierConfusion).sort();
      console.log("  Classifier Tier Confusion Matrix (rows=expected, cols=predicted):");
      console.log("  " + "-".repeat(66));
      console.log("  " + "".padEnd(12) + clfTierLabels.map((l) => l.padEnd(10)).join(""));
      for (const expected of clfTierLabels) {
        const row = clfTierLabels.map((predicted) => {
          const cell = classifierTierConfusion[expected]?.[predicted];
          return String(cell?.count ?? 0).padEnd(10);
        }).join("");
        console.log("  " + expected.padEnd(12) + row);
      }
      console.log("");
    }
  }

  // Misclassified entries summary (heuristic)
  const misses = entryResults.filter((e) => !e.tierCorrect || !e.pipelineCorrect);
  if (misses.length > 0) {
    console.log(`  Misclassified Entries (${misses.length}):`);
    console.log("  " + "-".repeat(66));
    for (const miss of misses) {
      const issues: string[] = [];
      if (!miss.tierCorrect) {
        issues.push(`tier: ${miss.expectedTier} -> ${miss.predictedTier}`);
      }
      if (!miss.pipelineCorrect) {
        issues.push(`pipe: ${miss.expectedPipeline} -> ${miss.predictedPipeline}`);
      }
      console.log(
        `  ${miss.id} [${miss.category}] ${issues.join(" | ")} ` +
        `(complexity: ${miss.complexity.toFixed(3)}, domain: ${miss.detectedDomain ?? "none"}, reason: ${miss.tierReason})`,
      );
    }
  }

  console.log("");
  console.log(`  Results written to: ${resultsPath}`);
  console.log("=".repeat(70));
}

run();
