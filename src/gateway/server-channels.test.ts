import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => {
  const computeBackoff = vi.fn(() => 10);
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { computeBackoff, sleepWithAbort };
});

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: hoisted.computeBackoff,
  sleepWithAbort: hoisted.sleepWithAbort,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
};

function createTestPlugin(params?: {
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
}): ChannelPlugin<TestAccount> {
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => account,
    isEnabled: (resolved) => resolved.enabled !== false,
  };
  if (includeDescribeAccount) {
    config.describeAccount = (resolved) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: resolved.enabled !== false,
      configured: resolved.configured !== false,
    });
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function installTestRegistry(plugin: ChannelPlugin<TestAccount>) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: plugin.id,
    source: "test",
    plugin,
  });
  setActivePluginRegistry(registry);
}

function createManager() {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: () => ({}),
    channelLogs,
    channelRuntimeEnvs,
  });
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(500);

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(10);

    await vi.advanceTimersByTimeAsync(500);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("does not auto-restart after manual stop during backoff", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    vi.runAllTicks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    await vi.advanceTimersByTimeAsync(500);
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("marks enabled/configured when account descriptors omit them", () => {
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.enabled).toBe(true);
    expect(account?.configured).toBe(true);
  });

  it("startChannel mutex collapses concurrent starts to a single startAccount invocation", async () => {
    // CRITICAL #1: TOCTOU at `if (store.tasks.has(id)) return;` allowed two
    // concurrent callers (health-monitor + auto-restart) to race past the
    // check and both materialise daemons. The per-channel:account mutex
    // collapses concurrent entries to a single in-flight start.
    let resolveStart: (() => void) | null = null;
    const startAccount = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    installTestRegistry(
      createTestPlugin({
        startAccount: startAccount as unknown as NonNullable<
          ChannelPlugin<TestAccount>["gateway"]
        >["startAccount"],
      }),
    );
    const manager = createManager();

    // Fire two concurrent startChannel invocations BEFORE the first resolves.
    const a = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    const b = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    // Drain microtasks so both calls progress through the mutex check.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Only one startAccount call materialises despite two concurrent starts.
    expect(startAccount).toHaveBeenCalledTimes(1);

    // Now resolve the in-flight start and let both promises settle.
    resolveStart?.();
    await a;
    await b;
  });

  it("stopChannel clears restartAttempts so subsequent starts get fresh restart budget", async () => {
    // CRITICAL #2: `restartAttempts` was populated on every channel exit and
    // never deleted on `stopChannel`. After 10 stop/start cycles a fresh
    // start would log "giving up after 10 restart attempts" with zero
    // network I/O because the restart counter survived the stop boundary.
    const startAccount = vi.fn(async () => {
      // Resolves immediately. The outer `.then()` increments restartAttempts.
    });
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    // Cycle: start (auto-restart logic increments counter) → stop (must
    // wipe counter) → start again. After 11 such cycles, the bug would
    // surface as `reconnectAttempts >= 10` on the latest start, since
    // every restart-attempt increment outlives its stop.
    for (let i = 0; i < 11; i += 1) {
      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      // Drain microtasks so the immediate-resolve startAccount promise
      // settles and the .then() auto-restart handler runs (incrementing
      // restartAttempts). We then call stopChannel BEFORE the backoff
      // expires; stopChannel must reset the counter.
      vi.runAllTicks();
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      const snap = manager.getRuntimeSnapshot();
      const account = snap.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
      // Each start has to begin from a clean restartAttempts budget — the
      // stop on the prior iteration must have cleared the counter.
      expect(account?.reconnectAttempts ?? 0).toBeLessThan(10);
    }
  });

  it("does not auto-restart a channel that published enabled:false (kill-switch path)", async () => {
    const startAccount = vi.fn(async (ctx: { setStatus: (next: unknown) => void }) => {
      // Channel deliberately disables itself (mirrors the signal kill-switch path):
      // resolves sub-millisecond after marking the runtime status enabled:false.
      // The auto-restart loop should NOT reschedule.
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        running: false,
        enabled: false,
        lastError: "inbound disabled",
      });
    });
    installTestRegistry(
      createTestPlugin({
        startAccount: startAccount as unknown as NonNullable<
          ChannelPlugin<TestAccount>["gateway"]
        >["startAccount"],
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    // Drain microtasks plus a generous window past the 5s restart backoff.
    await vi.advanceTimersByTimeAsync(60_000);

    // Without the auto-restart guard, startAccount would be called 11 times
    // (initial + 10 restart attempts) within this window.
    expect(startAccount).toHaveBeenCalledTimes(1);
  });
});
