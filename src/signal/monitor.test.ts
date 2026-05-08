import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { isSignalGroupAllowed } from "./identity.js";
import { monitorSignalProvider } from "./monitor.js";

describe("OPENCLAW_SIGNAL_INBOUND_ENABLED kill-switch", () => {
  it("returns immediately and logs disable message when set to 'false' (no abort wiring)", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const runtime: RuntimeEnv = {
      log: (...args) => logs.push(args.map(String).join(" ")),
      error: (...args) => errors.push(args.map(String).join(" ")),
      exit: (code) => {
        throw new Error(`unexpected exit(${code})`);
      },
    };
    const original = process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED;
    process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED = "false";
    try {
      await monitorSignalProvider({ runtime });
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED;
      } else {
        process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED = original;
      }
    }
    expect(logs.some((m) => m.includes("OPENCLAW_SIGNAL_INBOUND_ENABLED=false"))).toBe(true);
    expect(errors).toEqual([]);
  });

  it("publishes enabled:false status and suspends until abort when kill-switch engaged", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const runtime: RuntimeEnv = {
      log: (...args) => logs.push(args.map(String).join(" ")),
      error: (...args) => errors.push(args.map(String).join(" ")),
      exit: (code) => {
        throw new Error(`unexpected exit(${code})`);
      },
    };
    const statusCalls: Array<Record<string, unknown>> = [];
    const abort = new AbortController();

    const original = process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED;
    process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED = "false";

    let resolved = false;
    const monitorPromise = monitorSignalProvider({
      runtime,
      abortSignal: abort.signal,
      accountId: "kill-switch-acc",
      setStatus: (next) => statusCalls.push(next as Record<string, unknown>),
    }).then(() => {
      resolved = true;
    });

    // Yield enough microtasks for the monitor to publish status and await abort.
    await new Promise<void>((res) => setTimeout(res, 20));

    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]).toMatchObject({
      accountId: "kill-switch-acc",
      running: false,
      enabled: false,
    });
    expect(typeof statusCalls[0]?.lastError).toBe("string");
    expect(String(statusCalls[0]?.lastError)).toContain(
      "OPENCLAW_SIGNAL_INBOUND_ENABLED=false",
    );
    expect(resolved).toBe(false);

    abort.abort();
    await monitorPromise;
    expect(resolved).toBe(true);
    expect(errors).toEqual([]);

    if (original === undefined) {
      delete process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED;
    } else {
      process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED = original;
    }
  });

  it("returns immediately if abort already fired before invocation", async () => {
    const logs: string[] = [];
    const runtime: RuntimeEnv = {
      log: (...args) => logs.push(args.map(String).join(" ")),
      error: () => {},
      exit: () => {
        throw new Error("unexpected exit");
      },
    };
    const abort = new AbortController();
    abort.abort();

    const original = process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED;
    process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED = "false";
    try {
      await monitorSignalProvider({
        runtime,
        abortSignal: abort.signal,
        accountId: "default",
        setStatus: () => {},
      });
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED;
      } else {
        process.env.OPENCLAW_SIGNAL_INBOUND_ENABLED = original;
      }
    }
    // Just ensures we don't hang.
  });
});

describe("signal groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "open",
        allowFrom: [],
        sender: { kind: "phone", raw: "+15550001111", e164: "+15550001111" },
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "disabled",
        allowFrom: ["+15550001111"],
        sender: { kind: "phone", raw: "+15550001111", e164: "+15550001111" },
      }),
    ).toBe(false);
  });

  it("blocks allowlist when empty", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: [],
        sender: { kind: "phone", raw: "+15550001111", e164: "+15550001111" },
      }),
    ).toBe(false);
  });

  it("allows allowlist when sender matches", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["+15550001111"],
        sender: { kind: "phone", raw: "+15550001111", e164: "+15550001111" },
      }),
    ).toBe(true);
  });

  it("allows allowlist wildcard", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["*"],
        sender: { kind: "phone", raw: "+15550002222", e164: "+15550002222" },
      }),
    ).toBe(true);
  });

  it("allows allowlist when uuid sender matches", () => {
    expect(
      isSignalGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
        sender: {
          kind: "uuid",
          raw: "123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    ).toBe(true);
  });
});
