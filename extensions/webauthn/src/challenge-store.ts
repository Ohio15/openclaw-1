/**
 * In-memory challenge store with TTL-based expiry.
 *
 * WebAuthn challenges must be stored between the options generation and
 * the verification step. Each challenge is keyed by a string identifier
 * (e.g. "registration:{hash}" or "authentication:{code}") and expires
 * after CHALLENGE_TTL_SECONDS (300s / 5 minutes).
 */

const CHALLENGE_TTL_MS = 300_000; // 5 minutes

type ChallengeEntry = {
  challenge: string; // base64-encoded challenge bytes
  createdAt: number;
  extra?: Record<string, unknown>;
};

export class ChallengeStore {
  private challenges = new Map<string, ChallengeEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Run cleanup every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Allow the process to exit without waiting for this timer
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  set(key: string, challenge: Buffer | Uint8Array, extra?: Record<string, unknown>): void {
    this.challenges.set(key, {
      challenge: Buffer.from(challenge).toString("base64"),
      createdAt: Date.now(),
      extra,
    });
    // Inline cleanup of expired entries on each set
    this.cleanup();
  }

  get(key: string): Uint8Array | null {
    const entry = this.challenges.get(key);
    if (!entry) {
      return null;
    }
    // Remove after retrieval (one-time use)
    this.challenges.delete(key);

    if (Date.now() - entry.createdAt > CHALLENGE_TTL_MS) {
      return null;
    }
    return new Uint8Array(Buffer.from(entry.challenge, "base64"));
  }

  delete(key: string): void {
    this.challenges.delete(key);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.challenges) {
      if (now - entry.createdAt > CHALLENGE_TTL_MS) {
        this.challenges.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.challenges.clear();
  }
}
