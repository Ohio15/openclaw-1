import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const MAX_RETRIES = 5;

/**
 * Entries older than this are never replayed on recovery; they are moved to
 * failed/ instead. Queued payloads are conversational replies, and a reply
 * that lands a day after the turn it answers is wrong rather than late:
 * the conversation has moved on and the user may already have re-asked. 24h
 * matches the window chat platforms themselves treat as "still in
 * conversation" (WhatsApp Business free-form reply window). Crash recovery
 * normally replays within minutes of the crash, so this only removes entries
 * that were stranded across a long outage or a recovery bug.
 */
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

type DeliveryMirrorPayload = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
};

export interface QueuedDelivery {
  id: string;
  enqueuedAt: number;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
  retryCount: number;
  /** Wall-clock time of the most recent failed attempt; backoff is measured from here. */
  lastAttemptAt?: number;
  lastError?: string;
}

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}

/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
};

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = crypto.randomUUID();
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
    mirror: params.mirror,
    retryCount: 0,
  };
  const filePath = path.join(queueDir, `${id}.json`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(entry, null, 2);
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
  return id;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code !== "ENOENT") {
      throw err;
    }
    // Already removed — no-op.
  }
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const entry: QueuedDelivery = JSON.parse(raw);
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const queueDir = resolveQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const entries: QueuedDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      entries.push(JSON.parse(raw));
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }
  return entries;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const src = path.join(queueDir, `${id}.json`);
  const dest = path.join(failedDir, `${id}.json`);
  await fs.promises.rename(src, dest);
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryParams & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type RetryEligibility = { eligible: true } | { eligible: false; remainingBackoffMs: number };

/**
 * Decide whether an entry's backoff has elapsed. After N failed attempts the
 * entry waits computeBackoffMs(N), measured from its last attempt (entries
 * written before lastAttemptAt existed fall back to enqueuedAt). An entry that
 * has never been attempted is a crash replay and is eligible immediately.
 */
export function isEntryEligibleForRetry(entry: QueuedDelivery, now: number): RetryEligibility {
  const backoff = computeBackoffMs(entry.retryCount);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const lastAttemptAt =
    typeof entry.lastAttemptAt === "number" && Number.isFinite(entry.lastAttemptAt)
      ? entry.lastAttemptAt
      : entry.enqueuedAt;
  const remainingBackoffMs = lastAttemptAt + backoff - now;
  return remainingBackoffMs > 0 ? { eligible: false, remainingBackoffMs } : { eligible: true };
}

export type RecoverySummary = {
  recovered: number;
  failed: number;
  /** Moved to failed/ after exhausting MAX_RETRIES. */
  skipped: number;
  /** Backoff not yet elapsed; left in the queue for a later recovery pass. */
  deferred: number;
  /** Older than the max entry age (or without a valid enqueue time); moved to failed/ unsent. */
  expired: number;
};

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Entries whose backoff has not elapsed are left in place (they never block
 * the entries behind them); entries that exceed MAX_RETRIES or the max entry
 * age are moved to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time spent sending, in ms. Remaining entries are deferred to next restart. Default: 60 000. */
  maxRecoveryMs?: number;
  /** Entries enqueued longer ago than this are moved to failed/ without a send. Default: 24h. */
  maxEntryAgeMs?: number;
}): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    recovered: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    expired: 0,
  };
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return summary;
  }

  // Process oldest first.
  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);
  const maxEntryAgeMs = opts.maxEntryAgeMs ?? MAX_ENTRY_AGE_MS;

  const moveEntryToFailed = async (entry: QueuedDelivery): Promise<void> => {
    try {
      await moveToFailed(entry.id, opts.stateDir);
    } catch (err) {
      opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
    }
  };

  for (const [index, entry] of pending.entries()) {
    const now = Date.now();
    if (now >= deadline) {
      opts.log.warn(
        `Recovery time budget exceeded — ${pending.length - index} entries deferred to next restart`,
      );
      break;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed/`,
      );
      await moveEntryToFailed(entry);
      summary.skipped += 1;
      continue;
    }

    const ageMs = now - entry.enqueuedAt;
    if (!Number.isFinite(ageMs) || ageMs > maxEntryAgeMs) {
      opts.log.warn(
        `Delivery ${entry.id} is too old to replay (age ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s` : "unknown"}, max ${Math.round(maxEntryAgeMs / 1000)}s, retries ${entry.retryCount}) — moving to failed/`,
      );
      await moveEntryToFailed(entry);
      summary.expired += 1;
      continue;
    }

    const eligibility = isEntryEligibleForRetry(entry, now);
    if (!eligibility.eligible) {
      opts.log.info(
        `Delivery ${entry.id} not ready for retry yet — backoff ${eligibility.remainingBackoffMs}ms remaining`,
      );
      summary.deferred += 1;
      continue;
    }

    try {
      await opts.deliver({
        cfg: opts.cfg,
        channel: entry.channel,
        to: entry.to,
        accountId: entry.accountId,
        payloads: entry.payloads,
        threadId: entry.threadId,
        replyToId: entry.replyToId,
        bestEffort: entry.bestEffort,
        gifPlayback: entry.gifPlayback,
        silent: entry.silent,
        mirror: entry.mirror,
        skipQueue: true, // Prevent re-enqueueing during recovery
      });
      await ackDelivery(entry.id, opts.stateDir);
      summary.recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      try {
        await failDelivery(
          entry.id,
          err instanceof Error ? err.message : String(err),
          opts.stateDir,
        );
      } catch {
        // Best-effort update.
      }
      summary.failed += 1;
      opts.log.warn(
        `Retry failed for delivery ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skipped} skipped (max retries), ${summary.deferred} deferred (backoff), ${summary.expired} expired (too old)`,
  );
  return summary;
}

export { MAX_ENTRY_AGE_MS, MAX_RETRIES };
