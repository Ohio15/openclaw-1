/**
 * Persistent storage for WebAuthn passkey credentials.
 *
 * Stores registered credentials as JSON on disk so they survive restarts.
 * Single-user system — one owner with multiple passkeys.
 * Uses atomic owner-only writes (0600 temp file + rename) to prevent corruption
 * and to keep other local principals from adding their own credential.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ensurePrivateDir, writePrivateFileAtomic } from "./storage.js";

type PluginLogger = OpenClawPluginApi["logger"];

export type PasskeyCredential = {
  id: string;
  public_key: string;
  sign_count: number;
  name: string;
  registered_at: number;
};

const REQUIRED_KEYS: ReadonlySet<string> = new Set(["id", "public_key"]);

export class PasskeyStore {
  private storePath: string;
  private credentials: PasskeyCredential[] = [];
  private logger: PluginLogger;

  constructor(storePath: string, logger: PluginLogger) {
    this.storePath = storePath;
    this.logger = logger;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.storePath)) {
        this.credentials = [];
        return;
      }
      const raw = readFileSync(this.storePath, "utf-8");
      const data: unknown = JSON.parse(raw);

      if (!Array.isArray(data)) {
        this.logger.error(
          `webauthn: passkey store corrupted — root is not an array (${typeof data}), loading empty`,
        );
        this.credentials = [];
        return;
      }

      const valid: PasskeyCredential[] = [];
      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          this.logger.warn(`webauthn: passkey store — skipping non-object entry at index ${i}`);
          continue;
        }
        const record = entry as Record<string, unknown>;
        const missingKeys: string[] = [];
        for (const key of REQUIRED_KEYS) {
          if (!(key in record)) {
            missingKeys.push(key);
          }
        }
        if (missingKeys.length > 0) {
          this.logger.warn(
            `webauthn: passkey store — skipping entry at index ${i}, missing keys: ${missingKeys.join(", ")}`,
          );
          continue;
        }
        valid.push(record as unknown as PasskeyCredential);
      }

      this.credentials = valid;
      const skipped = data.length - valid.length;
      this.logger.info(
        `webauthn: passkeys loaded — count=${valid.length}${skipped > 0 ? `, skipped=${skipped}` : ""}`,
      );
    } catch (err) {
      if (err instanceof SyntaxError) {
        this.logger.error(`webauthn: passkey store JSON corrupted, loading empty — ${err.message}`);
      } else {
        this.logger.error(`webauthn: failed to load passkeys — ${String(err)}`);
      }
      this.credentials = [];
    }
  }

  /**
   * Persist all credentials atomically with mode 0600, creating the parent
   * directory (0700) if needed. Throws on failure: a credential that never
   * reached disk must not be reported as registered, or it silently vanishes
   * on the next restart.
   */
  save(): void {
    try {
      ensurePrivateDir(dirname(this.storePath), { tighten: false });
      writePrivateFileAtomic(this.storePath, JSON.stringify(this.credentials, null, 2));
    } catch (err) {
      this.logger.error(`webauthn: failed to save passkeys to ${this.storePath} — ${String(err)}`);
      throw err;
    }
  }

  /** Add and persist a credential. On a failed write the in-memory list is rolled back. */
  add(credential: PasskeyCredential): void {
    this.credentials.push(credential);
    try {
      this.save();
    } catch (err) {
      this.credentials = this.credentials.filter((c) => c !== credential);
      throw err;
    }
    this.logger.info(`webauthn: passkey registered — name=${credential.name}`);
  }

  listAll(): PasskeyCredential[] {
    return this.credentials;
  }

  findById(credentialId: string): PasskeyCredential | undefined {
    return this.credentials.find((c) => c.id === credentialId);
  }

  get hasCredentials(): boolean {
    return this.credentials.length > 0;
  }
}
