/**
 * FeedbackLoop - File-based feedback storage using JSONL
 *
 * Ported from AICodeAssistant's MongoDB-based FeedbackLoop to a lightweight
 * file-based implementation using append-only JSONL (JSON Lines).
 * No external dependencies — uses Node.js fs for all operations.
 *
 * @module feedback-loop
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface FeedbackEntry {
  /** Confidence score 0-1 from the intelligence pipeline */
  confidence: number;
  /** Whether the response passed the coherence gate */
  coherent: boolean;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Optional: detected task category */
  category?: string;
  /** Optional: tier used for generation */
  tier?: string;
  /** Optional: pipeline type (simple/complex) */
  pipeline?: string;
  /** Optional: whether refusal was detected */
  refusalDetected?: boolean;
  /** Optional: complexity score */
  complexity?: number;
  /** Optional: domain detected */
  domain?: string;
  /** Optional: list of issues found */
  issues?: string[];
  /** Optional: whether this was a chained execution */
  chainedExecution?: boolean;
  /** Optional: number of sub-task steps in chained execution */
  subTaskCount?: number;
  /** Optional: per-step quality scores from chained execution */
  subTaskScores?: Record<string, number>;
  /** Optional: tools that were executed in a sandbox */
  sandboxedTools?: string[];
  /** Optional: number of sandbox security violations detected */
  sandboxViolations?: number;
}

export interface CategoryInsight {
  category: string;
  count: number;
  avgConfidence: number;
  coherenceRate: number;
  refusalRate: number;
}

export interface FeedbackInsights {
  /** Total number of feedback entries analyzed */
  totalEntries: number;
  /** Average confidence score across all entries */
  avgConfidence: number;
  /** Percentage of coherent responses */
  coherenceRate: number;
  /** Percentage of entries with refusal detected */
  refusalRate: number;
  /** Breakdown by category */
  byCategory: CategoryInsight[];
  /** Breakdown by tier */
  byTier: Record<string, { count: number; avgConfidence: number }>;
  /** Breakdown by pipeline type */
  byPipeline: Record<string, { count: number; avgConfidence: number }>;
  /** Time window covered */
  oldestEntry: number;
  newestEntry: number;
  /** When insights were generated */
  generatedAt: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect request category from keywords (mirrors AICodeAssistant's detectCategory).
 */
export function detectCategory(text: string): string {
  const lower = text.toLowerCase();

  if (/algorithm|data structure|sort|search|tree|graph|heap/.test(lower)) return "algorithm";
  if (/security|auth|jwt|oauth|csrf|xss/.test(lower)) return "security";
  if (/react|vue|angular|frontend|component|hook/.test(lower)) return "frontend";
  if (/express|api|backend|server|endpoint|rest/.test(lower)) return "backend";
  if (/docker|kubernetes|ci\/cd|deploy/.test(lower)) return "devops";
  if (/mongodb|postgres|database|prisma|sql/.test(lower)) return "database";
  if (/test|jest|vitest|playwright/.test(lower)) return "testing";
  if (/websocket|realtime|socket/.test(lower)) return "realtime";

  return "general";
}

// ============================================================================
// FeedbackLoop Class
// ============================================================================

export class FeedbackLoop {
  private dirEnsured = false;

  constructor(private feedbackPath: string) {}

  /**
   * Ensure the parent directory exists (only checked once per instance).
   */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.feedbackPath), { recursive: true });
    this.dirEnsured = true;
  }

  /**
   * Append a feedback entry to the JSONL file.
   */
  async record(entry: FeedbackEntry): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.feedbackPath, line, "utf-8");
  }

  /**
   * Read all entries from the JSONL file.
   * Returns empty array if the file doesn't exist yet.
   */
  private async readAll(): Promise<FeedbackEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.feedbackPath, "utf-8");
    } catch (err: unknown) {
      // File doesn't exist yet — no entries
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const entries: FeedbackEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as FeedbackEntry);
      } catch {
        // Skip malformed lines — don't crash on partial writes
      }
    }
    return entries;
  }

  /**
   * Aggregate feedback entries into actionable insights.
   */
  async getInsights(): Promise<FeedbackInsights> {
    const entries = await this.readAll();

    if (entries.length === 0) {
      return {
        totalEntries: 0,
        avgConfidence: 0,
        coherenceRate: 0,
        refusalRate: 0,
        byCategory: [],
        byTier: {},
        byPipeline: {},
        oldestEntry: 0,
        newestEntry: 0,
        generatedAt: Date.now(),
      };
    }

    // Global aggregations
    let totalConfidence = 0;
    let coherentCount = 0;
    let refusalCount = 0;
    let oldestEntry = Infinity;
    let newestEntry = 0;

    // Category aggregation
    const catMap = new Map<
      string,
      { count: number; totalConfidence: number; coherentCount: number; refusalCount: number }
    >();

    // Tier aggregation
    const tierMap = new Map<string, { count: number; totalConfidence: number }>();

    // Pipeline aggregation
    const pipelineMap = new Map<string, { count: number; totalConfidence: number }>();

    for (const entry of entries) {
      totalConfidence += entry.confidence;
      if (entry.coherent) coherentCount++;
      if (entry.refusalDetected) refusalCount++;
      if (entry.timestamp < oldestEntry) oldestEntry = entry.timestamp;
      if (entry.timestamp > newestEntry) newestEntry = entry.timestamp;

      // Category
      const cat = entry.category ?? "unknown";
      const catAcc = catMap.get(cat) ?? { count: 0, totalConfidence: 0, coherentCount: 0, refusalCount: 0 };
      catAcc.count++;
      catAcc.totalConfidence += entry.confidence;
      if (entry.coherent) catAcc.coherentCount++;
      if (entry.refusalDetected) catAcc.refusalCount++;
      catMap.set(cat, catAcc);

      // Tier
      if (entry.tier) {
        const tierAcc = tierMap.get(entry.tier) ?? { count: 0, totalConfidence: 0 };
        tierAcc.count++;
        tierAcc.totalConfidence += entry.confidence;
        tierMap.set(entry.tier, tierAcc);
      }

      // Pipeline
      if (entry.pipeline) {
        const pipeAcc = pipelineMap.get(entry.pipeline) ?? { count: 0, totalConfidence: 0 };
        pipeAcc.count++;
        pipeAcc.totalConfidence += entry.confidence;
        pipelineMap.set(entry.pipeline, pipeAcc);
      }
    }

    // Build category insights sorted by count descending
    const byCategory: CategoryInsight[] = Array.from(catMap.entries())
      .map(([category, acc]) => ({
        category,
        count: acc.count,
        avgConfidence: acc.totalConfidence / acc.count,
        coherenceRate: acc.coherentCount / acc.count,
        refusalRate: acc.refusalCount / acc.count,
      }))
      .sort((a, b) => b.count - a.count);

    // Build tier map
    const byTier: Record<string, { count: number; avgConfidence: number }> = {};
    for (const [tier, acc] of tierMap.entries()) {
      byTier[tier] = { count: acc.count, avgConfidence: acc.totalConfidence / acc.count };
    }

    // Build pipeline map
    const byPipeline: Record<string, { count: number; avgConfidence: number }> = {};
    for (const [pipe, acc] of pipelineMap.entries()) {
      byPipeline[pipe] = { count: acc.count, avgConfidence: acc.totalConfidence / acc.count };
    }

    return {
      totalEntries: entries.length,
      avgConfidence: totalConfidence / entries.length,
      coherenceRate: coherentCount / entries.length,
      refusalRate: refusalCount / entries.length,
      byCategory,
      byTier,
      byPipeline,
      oldestEntry: oldestEntry === Infinity ? 0 : oldestEntry,
      newestEntry,
      generatedAt: Date.now(),
    };
  }
}
