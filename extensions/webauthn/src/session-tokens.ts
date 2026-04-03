/**
 * In-memory session token store with 24-hour TTL.
 *
 * After a successful passkey browser login, a session token is issued
 * that can be used as a Bearer token for subsequent requests.
 */

import { randomBytes } from "node:crypto";

const SESSION_TOKEN_TTL_MS = 86_400_000; // 24 hours

type SessionEntry = {
  createdAt: number;
  expiresAt: number;
};

export class SessionTokenStore {
  private sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 300_000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  createSessionToken(): string {
    this.cleanup();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions.set(token, {
      createdAt: now,
      expiresAt: now + SESSION_TOKEN_TTL_MS,
    });
    return token;
  }

  validateSessionToken(token: string): boolean {
    if (!token) {
      return false;
    }
    const entry = this.sessions.get(token);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.expiresAt) {
      // Lazy cleanup
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now > entry.expiresAt) {
        this.sessions.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
