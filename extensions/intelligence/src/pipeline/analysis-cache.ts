/**
 * Analysis Cache — TTL-based cache for intelligence pipeline analysis results.
 *
 * Prevents the triple-computation problem where analyzeBeforeAgent() was called
 * once per hook (before_model_resolve, before_prompt_build, agent_end).
 * Now the first call computes and caches; subsequent calls within the TTL window
 * return the cached result.
 *
 * Keyed by prompt hash (djb2 of last user message text).
 *
 * @module analysis-cache
 */

// ============================================================================
// Types
// ============================================================================

interface CacheEntry<T> {
  result: T;
  cachedAt: number;
}

// ============================================================================
// Hash
// ============================================================================

/**
 * Fast non-cryptographic hash (djb2) for cache key generation.
 */
export function promptHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

// ============================================================================
// AnalysisCache
// ============================================================================

export class AnalysisCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 60_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get a cached result by key. Returns undefined if not cached or expired.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  /**
   * Store a result in the cache.
   */
  set(key: string, result: T): void {
    this.cache.set(key, { result, cachedAt: Date.now() });
  }

  /**
   * Clear a specific key, or all entries if no key provided.
   */
  clear(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Remove all expired entries. Call periodically to prevent memory leaks
   * in long-running processes.
   */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }
}
