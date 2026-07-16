import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDispatchInboundCaptureMock } from "../../../test/helpers/dispatch-inbound-capture.js";

// Replace the real agent dispatch with a fast capture stub. The brain-ingest
// hook lives in the handler *after* dispatchInboundMessage returns, so stubbing
// dispatch does not bypass it.
vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return buildDispatchInboundCaptureMock(actual, () => {});
});

// Spy on the brain-ingest bridge to assert whether a capture was forwarded.
// Hoisted so the vi.mock factory (itself hoisted) can reference it safely.
const { captureInboundToBrain } = vi.hoisted(() => ({
  captureInboundToBrain: vi.fn(async () => {}),
}));
vi.mock("../../infra/brain-ingest.js", () => ({ captureInboundToBrain }));

import { createSignalEventHandler } from "./event-handler.js";
import { createBaseSignalEventHandlerDeps } from "./event-handler.test-harness.js";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

function receive(message: string) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceUuid: "uuid-ron",
        sourceName: "Ron",
        timestamp: 1700000000000,
        dataMessage: { message, attachments: [] },
      },
    }),
  };
}

function makeHandler(overrides: Partial<SignalEventHandlerDeps>) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      historyLimit: 0,
      ...overrides,
    }),
  );
}

describe("signal brain-ingest hook", () => {
  beforeEach(() => {
    captureInboundToBrain.mockClear();
  });

  it("forwards a message that passed the DM allowlist", async () => {
    const handler = makeHandler({ dmPolicy: "open" });
    await handler(receive("ship it"));
    expect(captureInboundToBrain).toHaveBeenCalledTimes(1);
  });

  it("does not forward a message rejected by the DM policy", async () => {
    const handler = makeHandler({ dmPolicy: "disabled" });
    await handler(receive("ship it"));
    expect(captureInboundToBrain).not.toHaveBeenCalled();
  });
});
