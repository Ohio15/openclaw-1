import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";

// HIGH #5 coverage: the hot-reload restart sequence must wait for any
// in-flight startChannel to settle before issuing stopChannel. Otherwise a
// concurrent health-monitor or auto-restart start can land between the
// rug-pull stop and the follow-on start, leaving an orphan transport.

function createSilentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Hot-reload state shape is private to server-reload-handlers; the
// tests only need a structural stand-in. Casting to `never` lets the
// parameter type erase the real signature without leaking into the
// `state` variable's inferred shape (which would block re-assignment
// in `setState`).
type LooseState = Parameters<
  Parameters<typeof createGatewayReloadHandlers>[0]["setState"]
>[0];

function createState(): LooseState {
  return {
    hooksConfig: {},
    heartbeatRunner: {
      updateConfig: () => {},
    },
    cronState: {
      cron: { stop: () => {}, start: async () => {} },
      storePath: "",
    },
    browserControl: null,
  } as unknown as LooseState;
}

function createPlan(channel: ChannelKind): GatewayReloadPlan {
  return {
    changedPaths: [`channels.${channel}`],
    restartGateway: false,
    restartReasons: [],
    hotReasons: [`channels.${channel}`],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartChannels: new Set([channel]),
    noopPaths: [],
  };
}

describe("createGatewayReloadHandlers — restart channel ordering (HIGH #5)", () => {
  it("waits for an in-flight startChannel to resolve before calling stopChannel", async () => {
    const calls: string[] = [];

    // Deferred promise — stand-in for the startChannel that the
    // health-monitor (or auto-restart) is mid-flight on when hot-reload
    // fires. Until we resolve it, the in-flight gate must hold the
    // restart sequence open.
    let releaseInFlight = () => {};
    const inFlightStart = new Promise<void>((resolve) => {
      releaseInFlight = () => {
        calls.push("inFlight:resolved");
        resolve();
      };
    });

    const startChannel = vi.fn(async (name: ChannelKind) => {
      calls.push(`start:${name}`);
    });
    const stopChannel = vi.fn(async (name: ChannelKind) => {
      calls.push(`stop:${name}`);
    });
    const awaitInFlightStart = vi.fn((name: ChannelKind) => {
      calls.push(`awaitInFlight:${name}`);
      return inFlightStart;
    });

    let state: LooseState = createState();
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: () => {},
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      startChannel,
      stopChannel,
      awaitInFlightStart,
      logHooks: createSilentLogger(),
      logBrowser: { error: () => {} },
      logChannels: { info: () => calls.push("log:restarting"), error: () => {} },
      logCron: { error: () => {} },
      logReload: { info: () => {}, warn: () => {} },
    });

    const plan = createPlan("signal");
    const reloadPromise = handlers.applyHotReload(plan, {} as OpenClawConfig);

    // Yield enough microtasks for the restart sequence to call
    // awaitInFlightStart and then suspend on it.
    await new Promise<void>((res) => setTimeout(res, 10));

    expect(awaitInFlightStart).toHaveBeenCalledWith("signal");
    // stopChannel and startChannel must not have fired yet — the
    // in-flight start hasn't settled.
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();

    releaseInFlight();
    await reloadPromise;

    expect(calls).toEqual([
      "log:restarting",
      "awaitInFlight:signal",
      "inFlight:resolved",
      "stop:signal",
      "start:signal",
    ]);
    expect(stopChannel).toHaveBeenCalledTimes(1);
    expect(startChannel).toHaveBeenCalledTimes(1);
  });

  it("proceeds straight to stop+start when no start is in flight", async () => {
    const calls: string[] = [];
    const startChannel = vi.fn(async (name: ChannelKind) => {
      calls.push(`start:${name}`);
    });
    const stopChannel = vi.fn(async (name: ChannelKind) => {
      calls.push(`stop:${name}`);
    });
    const awaitInFlightStart = vi.fn((_: ChannelKind) => undefined);

    let state: LooseState = createState();
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: () => {},
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      startChannel,
      stopChannel,
      awaitInFlightStart,
      logHooks: createSilentLogger(),
      logBrowser: { error: () => {} },
      logChannels: { info: () => {}, error: () => {} },
      logCron: { error: () => {} },
      logReload: { info: () => {}, warn: () => {} },
    });

    await handlers.applyHotReload(createPlan("telegram"), {} as OpenClawConfig);
    expect(awaitInFlightStart).toHaveBeenCalledWith("telegram");
    expect(calls).toEqual(["stop:telegram", "start:telegram"]);
  });

  it("swallows in-flight start rejection and still issues stop+start", async () => {
    const calls: string[] = [];
    const startChannel = vi.fn(async (name: ChannelKind) => {
      calls.push(`start:${name}`);
    });
    const stopChannel = vi.fn(async (name: ChannelKind) => {
      calls.push(`stop:${name}`);
    });
    // The in-flight start failed (bad config, transport down). Hot-reload
    // must still proceed — we waited for it to settle, that's the contract.
    const awaitInFlightStart = vi.fn((_: ChannelKind) =>
      Promise.reject(new Error("startup failed")),
    );

    let state: LooseState = createState();
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: () => {},
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      startChannel,
      stopChannel,
      awaitInFlightStart,
      logHooks: createSilentLogger(),
      logBrowser: { error: () => {} },
      logChannels: { info: () => {}, error: () => {} },
      logCron: { error: () => {} },
      logReload: { info: () => {}, warn: () => {} },
    });

    await handlers.applyHotReload(createPlan("signal"), {} as OpenClawConfig);
    expect(calls).toEqual(["stop:signal", "start:signal"]);
  });
});
