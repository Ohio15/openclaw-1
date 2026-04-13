/**
 * Learned Routing Classifier
 *
 * A random forest classifier built from scratch in TypeScript.
 * Trains on feature vectors extracted from benchmark prompts to predict
 * tier and pipeline routing decisions.
 *
 * No external ML dependencies — this is a ~100-sample, ~42-feature problem
 * where a random forest of shallow decision trees is optimal.
 *
 * @module learned-classifier
 */

import { readFileSync } from "node:fs";
import { extractFeatures, FEATURE_NAMES } from "./feature-extractor.js";

// ============================================================================
// Types
// ============================================================================

export interface TrainingSample {
  features: number[];
  tierLabel: string;
  pipelineLabel: string;
}

export interface ClassifierPrediction {
  tier: string;
  pipeline: string;
  tierConfidence: number;
  pipelineConfidence: number;
}

/** Serialized decision tree node */
interface TreeNode {
  /** Feature index to split on (-1 for leaf) */
  featureIndex: number;
  /** Threshold for split */
  threshold: number;
  /** Left child (feature <= threshold) */
  left: TreeNode | null;
  /** Right child (feature > threshold) */
  right: TreeNode | null;
  /** Leaf prediction (label string) — only set on leaf nodes */
  prediction: string | null;
  /** Class distribution at this node */
  distribution: Record<string, number>;
}

/** Serialized model */
export interface ClassifierModel {
  version: number;
  featureNames: string[];
  tierTrees: TreeNode[];
  pipelineTrees: TreeNode[];
  tierLabels: string[];
  pipelineLabels: string[];
  trainedAt: string;
  trainingSamples: number;
  trainingAccuracy: { tier: number; pipeline: number };
}

// ============================================================================
// Decision Tree Implementation
// ============================================================================

/**
 * Compute Gini impurity for a set of label counts.
 */
function giniImpurity(labelCounts: Record<string, number>, total: number): number {
  if (total === 0) return 0;
  let sumSq = 0;
  for (const count of Object.values(labelCounts)) {
    const p = count / total;
    sumSq += p * p;
  }
  return 1 - sumSq;
}

/**
 * Count labels in a subset of samples.
 */
function countLabels(
  samples: TrainingSample[],
  indices: number[],
  getLabel: (s: TrainingSample) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const idx of indices) {
    const label = getLabel(samples[idx]);
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

/**
 * Find the majority label in a set of samples.
 */
function majorityLabel(
  samples: TrainingSample[],
  indices: number[],
  getLabel: (s: TrainingSample) => string,
): string {
  const counts = countLabels(samples, indices, getLabel);
  let best = "";
  let bestCount = -1;
  for (const [label, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Find the best split for a set of samples.
 * Uses a random subset of features (sqrt(totalFeatures)) for random forest diversity.
 */
function findBestSplit(
  samples: TrainingSample[],
  indices: number[],
  getLabel: (s: TrainingSample) => string,
  featureSubset: number[],
): { featureIndex: number; threshold: number; leftIndices: number[]; rightIndices: number[] } | null {
  const totalCount = indices.length;
  if (totalCount <= 1) return null;

  const parentCounts = countLabels(samples, indices, getLabel);
  const parentGini = giniImpurity(parentCounts, totalCount);

  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeft: number[] = [];
  let bestRight: number[] = [];

  for (const fi of featureSubset) {
    // Get unique sorted values for this feature
    const values = indices.map((idx) => samples[idx].features[fi]);
    const sortedUnique = [...new Set(values)].sort((a, b) => a - b);

    if (sortedUnique.length <= 1) continue;

    // Try midpoints between consecutive unique values
    for (let i = 0; i < sortedUnique.length - 1; i++) {
      const threshold = (sortedUnique[i] + sortedUnique[i + 1]) / 2;

      const leftIndices: number[] = [];
      const rightIndices: number[] = [];

      for (const idx of indices) {
        if (samples[idx].features[fi] <= threshold) {
          leftIndices.push(idx);
        } else {
          rightIndices.push(idx);
        }
      }

      if (leftIndices.length === 0 || rightIndices.length === 0) continue;

      const leftCounts = countLabels(samples, leftIndices, getLabel);
      const rightCounts = countLabels(samples, rightIndices, getLabel);

      const leftGini = giniImpurity(leftCounts, leftIndices.length);
      const rightGini = giniImpurity(rightCounts, rightIndices.length);

      const weightedGini =
        (leftIndices.length / totalCount) * leftGini +
        (rightIndices.length / totalCount) * rightGini;

      const gain = parentGini - weightedGini;

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = fi;
        bestThreshold = threshold;
        bestLeft = leftIndices;
        bestRight = rightIndices;
      }
    }
  }

  if (bestGain <= 0) return null;

  return {
    featureIndex: bestFeature,
    threshold: bestThreshold,
    leftIndices: bestLeft,
    rightIndices: bestRight,
  };
}

/**
 * Build a decision tree recursively.
 */
function buildTree(
  samples: TrainingSample[],
  indices: number[],
  getLabel: (s: TrainingSample) => string,
  maxDepth: number,
  minSamplesLeaf: number,
  rng: () => number,
  depth: number = 0,
): TreeNode {
  const distribution = countLabels(samples, indices, getLabel);
  const prediction = majorityLabel(samples, indices, getLabel);

  // Stop conditions: max depth, pure node, too few samples
  const uniqueLabels = Object.keys(distribution).length;
  if (depth >= maxDepth || uniqueLabels <= 1 || indices.length < minSamplesLeaf * 2) {
    return {
      featureIndex: -1,
      threshold: 0,
      left: null,
      right: null,
      prediction,
      distribution,
    };
  }

  // Random feature subset (sqrt of total features, minimum 6)
  const numFeatures = samples[0].features.length;
  const subsetSize = Math.max(6, Math.ceil(Math.sqrt(numFeatures)));
  const allFeatureIndices = Array.from({ length: numFeatures }, (_, i) => i);
  const featureSubset = shuffleArray(allFeatureIndices, rng).slice(0, subsetSize);

  const split = findBestSplit(samples, indices, getLabel, featureSubset);

  if (!split) {
    return {
      featureIndex: -1,
      threshold: 0,
      left: null,
      right: null,
      prediction,
      distribution,
    };
  }

  return {
    featureIndex: split.featureIndex,
    threshold: split.threshold,
    left: buildTree(samples, split.leftIndices, getLabel, maxDepth, minSamplesLeaf, rng, depth + 1),
    right: buildTree(samples, split.rightIndices, getLabel, maxDepth, minSamplesLeaf, rng, depth + 1),
    prediction: null,
    distribution,
  };
}

/**
 * Predict using a single decision tree.
 */
function predictTree(node: TreeNode, features: number[]): { label: string; distribution: Record<string, number> } {
  if (node.featureIndex === -1 || !node.left || !node.right) {
    return { label: node.prediction ?? "", distribution: node.distribution };
  }

  if (features[node.featureIndex] <= node.threshold) {
    return predictTree(node.left, features);
  }
  return predictTree(node.right, features);
}

/**
 * Shuffle an array using Fisher-Yates with a provided RNG.
 */
function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Simple seeded RNG (mulberry32).
 */
function seededRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap sample (sampling with replacement).
 */
function bootstrapSample(indices: number[], rng: () => number): number[] {
  const n = indices.length;
  const sample: number[] = [];
  for (let i = 0; i < n; i++) {
    sample.push(indices[Math.floor(rng() * n)]);
  }
  return sample;
}

// ============================================================================
// Random Forest Classifier
// ============================================================================

export class LearnedClassifier {
  private tierTrees: TreeNode[] = [];
  private pipelineTrees: TreeNode[] = [];
  private tierLabels: string[] = [];
  private pipelineLabels: string[] = [];
  private trained = false;

  /**
   * Train the random forest on labeled samples.
   */
  train(
    samples: TrainingSample[],
    options: {
      numTrees?: number;
      maxDepth?: number;
      minSamplesLeaf?: number;
      seed?: number;
    } = {},
  ): { tierAccuracy: number; pipelineAccuracy: number } {
    const numTrees = options.numTrees ?? 50;
    const maxDepth = options.maxDepth ?? 8;
    const minSamplesLeaf = options.minSamplesLeaf ?? 2;
    const seed = options.seed ?? 42;

    this.tierLabels = [...new Set(samples.map((s) => s.tierLabel))].sort();
    this.pipelineLabels = [...new Set(samples.map((s) => s.pipelineLabel))].sort();

    const allIndices = Array.from({ length: samples.length }, (_, i) => i);

    // Build tier trees
    this.tierTrees = [];
    for (let t = 0; t < numTrees; t++) {
      const rng = seededRng(seed + t * 1000);
      const bootstrapIndices = bootstrapSample(allIndices, rng);
      const tree = buildTree(
        samples,
        bootstrapIndices,
        (s) => s.tierLabel,
        maxDepth,
        minSamplesLeaf,
        rng,
      );
      this.tierTrees.push(tree);
    }

    // Build pipeline trees
    this.pipelineTrees = [];
    for (let t = 0; t < numTrees; t++) {
      const rng = seededRng(seed + t * 1000 + 500000);
      const bootstrapIndices = bootstrapSample(allIndices, rng);
      const tree = buildTree(
        samples,
        bootstrapIndices,
        (s) => s.pipelineLabel,
        maxDepth,
        minSamplesLeaf,
        rng,
      );
      this.pipelineTrees.push(tree);
    }

    this.trained = true;

    // Compute in-sample accuracy
    let tierCorrect = 0;
    let pipelineCorrect = 0;
    for (const sample of samples) {
      const pred = this.predict(sample.features);
      if (pred.tier === sample.tierLabel) tierCorrect++;
      if (pred.pipeline === sample.pipelineLabel) pipelineCorrect++;
    }

    return {
      tierAccuracy: tierCorrect / samples.length,
      pipelineAccuracy: pipelineCorrect / samples.length,
    };
  }

  /**
   * Predict tier and pipeline for a feature vector.
   */
  predict(features: number[]): ClassifierPrediction {
    if (!this.trained) {
      throw new Error("Classifier not trained — call train() or loadModel() first");
    }

    // Aggregate tier votes
    const tierVotes: Record<string, number> = {};
    for (const tree of this.tierTrees) {
      const result = predictTree(tree, features);
      tierVotes[result.label] = (tierVotes[result.label] || 0) + 1;
    }

    // Aggregate pipeline votes
    const pipelineVotes: Record<string, number> = {};
    for (const tree of this.pipelineTrees) {
      const result = predictTree(tree, features);
      pipelineVotes[result.label] = (pipelineVotes[result.label] || 0) + 1;
    }

    // Find majority vote
    const tier = maxKey(tierVotes);
    const pipeline = maxKey(pipelineVotes);

    const totalTierVotes = Object.values(tierVotes).reduce((a, b) => a + b, 0);
    const totalPipelineVotes = Object.values(pipelineVotes).reduce((a, b) => a + b, 0);

    return {
      tier,
      pipeline,
      tierConfidence: totalTierVotes > 0 ? (tierVotes[tier] || 0) / totalTierVotes : 0,
      pipelineConfidence: totalPipelineVotes > 0 ? (pipelineVotes[pipeline] || 0) / totalPipelineVotes : 0,
    };
  }

  /**
   * Predict from a raw prompt string (extracts features internally).
   */
  predictFromPrompt(prompt: string): ClassifierPrediction {
    const features = extractFeatures(prompt);
    return this.predict(features);
  }

  /**
   * Serialize the trained model to a JSON-compatible object.
   */
  serialize(trainingSamples: number): ClassifierModel {
    if (!this.trained) {
      throw new Error("Cannot serialize an untrained classifier");
    }

    // Compute a dummy accuracy (will be overwritten by the caller)
    return {
      version: 1,
      featureNames: [...FEATURE_NAMES],
      tierTrees: this.tierTrees,
      pipelineTrees: this.pipelineTrees,
      tierLabels: this.tierLabels,
      pipelineLabels: this.pipelineLabels,
      trainedAt: new Date().toISOString(),
      trainingSamples,
      trainingAccuracy: { tier: 0, pipeline: 0 },
    };
  }

  /**
   * Load a serialized model.
   */
  loadModel(model: ClassifierModel): void {
    if (model.version !== 1) {
      throw new Error(`Unsupported model version: ${model.version}`);
    }
    this.tierTrees = model.tierTrees;
    this.pipelineTrees = model.pipelineTrees;
    this.tierLabels = model.tierLabels;
    this.pipelineLabels = model.pipelineLabels;
    this.trained = true;
  }

  /**
   * Load a serialized model from a JSON file path.
   * Returns true if loaded successfully, false if file doesn't exist.
   */
  loadModelFromFile(filePath: string): boolean {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const model: ClassifierModel = JSON.parse(raw);
      this.loadModel(model);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the classifier has a trained model loaded.
   */
  get isReady(): boolean {
    return this.trained;
  }
}

/**
 * Find the key with the highest value in a record.
 */
function maxKey(record: Record<string, number>): string {
  let best = "";
  let bestVal = -Infinity;
  for (const [key, val] of Object.entries(record)) {
    if (val > bestVal) {
      best = key;
      bestVal = val;
    }
  }
  return best;
}
