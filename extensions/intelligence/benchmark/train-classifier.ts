/**
 * Training Script for Learned Routing Classifier
 *
 * Reads suite.json, extracts features from each prompt, trains the random
 * forest classifier, and serializes the model to classifier-model.json.
 *
 * Usage:
 *   pnpm --filter ./extensions/intelligence exec tsx benchmark/train-classifier.ts
 *
 * @module benchmark/train-classifier
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFeatures, FEATURE_NAMES } from "../src/pipeline/feature-extractor.js";
import {
  LearnedClassifier,
  type TrainingSample,
  type ClassifierModel,
} from "../src/pipeline/learned-classifier.js";

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

// ============================================================================
// Main
// ============================================================================

function train(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const suitePath = resolve(__dirname, "suite.json");
  const modelPath = resolve(__dirname, "classifier-model.json");

  console.log("=".repeat(60));
  console.log("  Training Learned Routing Classifier");
  console.log("=".repeat(60));

  // Load benchmark suite
  const raw = readFileSync(suitePath, "utf-8");
  const suite: BenchmarkEntry[] = JSON.parse(raw);
  console.log(`  Loaded ${suite.length} training samples from suite.json`);

  // Extract features
  const samples: TrainingSample[] = suite.map((entry) => ({
    features: extractFeatures(entry.prompt),
    tierLabel: entry.expectedTier,
    pipelineLabel: entry.expectedPipeline,
  }));

  console.log(`  Feature vector length: ${FEATURE_NAMES.length}`);
  console.log(`  Features: ${FEATURE_NAMES.join(", ")}`);
  console.log("");

  // Print label distribution
  const tierDist: Record<string, number> = {};
  const pipeDist: Record<string, number> = {};
  for (const s of samples) {
    tierDist[s.tierLabel] = (tierDist[s.tierLabel] || 0) + 1;
    pipeDist[s.pipelineLabel] = (pipeDist[s.pipelineLabel] || 0) + 1;
  }
  console.log("  Tier distribution:");
  for (const [label, count] of Object.entries(tierDist).sort()) {
    console.log(`    ${label}: ${count}`);
  }
  console.log("  Pipeline distribution:");
  for (const [label, count] of Object.entries(pipeDist).sort()) {
    console.log(`    ${label}: ${count}`);
  }
  console.log("");

  // Train classifier
  const classifier = new LearnedClassifier();
  console.log("  Training random forest (50 trees, maxDepth=8)...");

  const accuracy = classifier.train(samples, {
    numTrees: 50,
    maxDepth: 8,
    minSamplesLeaf: 1,
    seed: 42,
  });

  console.log(`  Training tier accuracy:     ${(accuracy.tierAccuracy * 100).toFixed(1)}%`);
  console.log(`  Training pipeline accuracy: ${(accuracy.pipelineAccuracy * 100).toFixed(1)}%`);
  console.log("");

  // Per-tier accuracy breakdown
  const tierResults: Record<string, { correct: number; total: number }> = {};
  for (const sample of samples) {
    const pred = classifier.predict(sample.features);
    if (!tierResults[sample.tierLabel]) {
      tierResults[sample.tierLabel] = { correct: 0, total: 0 };
    }
    tierResults[sample.tierLabel].total++;
    if (pred.tier === sample.tierLabel) {
      tierResults[sample.tierLabel].correct++;
    }
  }

  console.log("  Per-tier accuracy:");
  for (const [tier, stats] of Object.entries(tierResults).sort()) {
    console.log(
      `    ${tier.padEnd(12)} ${stats.correct}/${stats.total} (${((stats.correct / stats.total) * 100).toFixed(1)}%)`,
    );
  }
  console.log("");

  // Serialize model
  const model: ClassifierModel = classifier.serialize(samples.length);
  model.trainingAccuracy = accuracy;
  writeFileSync(modelPath, JSON.stringify(model), "utf-8");

  const fileSizeKB = (Buffer.byteLength(JSON.stringify(model)) / 1024).toFixed(1);
  console.log(`  Model serialized to: ${modelPath}`);
  console.log(`  Model size: ${fileSizeKB} KB`);

  // Verify round-trip
  const verifier = new LearnedClassifier();
  const loaded = verifier.loadModelFromFile(modelPath);
  if (!loaded) {
    console.error("  ERROR: Failed to load serialized model!");
    process.exit(1);
  }

  let roundTripCorrect = 0;
  for (const sample of samples) {
    const orig = classifier.predict(sample.features);
    const rt = verifier.predict(sample.features);
    if (orig.tier === rt.tier && orig.pipeline === rt.pipeline) {
      roundTripCorrect++;
    }
  }

  console.log(
    `  Round-trip verification: ${roundTripCorrect}/${samples.length} predictions match`,
  );

  if (roundTripCorrect !== samples.length) {
    console.error("  WARNING: Round-trip mismatch detected!");
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("  Training complete.");
  console.log("=".repeat(60));
}

train();
