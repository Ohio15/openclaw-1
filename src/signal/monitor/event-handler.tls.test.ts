import { beforeEach, describe, expect, it, vi } from "vitest";

// The event handler is the one place that calls into `send.js` with both
// `baseUrl` and `account` already known, which makes `resolveSignalRpcContext`
// skip account resolution and never read the config's TLS block. Every send from
// here therefore has to pass `deps.tls` explicitly; dropping it would put the
// typing / pairing / read-receipt traffic back on plaintext without any other
// test noticing.
const sendMessageSignalMock = vi.hoisted(() => vi.fn());
const sendTypingSignalMock = vi.hoisted(() => vi.fn());
const sendReadReceiptSignalMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMessageSignalMock(...args),
  sendTypingSignal: (...args: unknown[]) => sendTypingSignalMock(...args),
  sendReadReceiptSignal: (...args: unknown[]) => sendReadReceiptSignalMock(...args),
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(
    async (params: { replyOptions?: { onReplyStart?: () => Promise<void> } }) => {
      // Fire the typing hook the reply pipeline would fire, so the
      // sendTypingSignal call site is actually exercised.
      await params.replyOptions?.onReplyStart?.();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  );
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

import { createSignalEventHandler } from "./event-handler.js";
import { createBaseSignalEventHandlerDeps } from "./event-handler.test-harness.js";

const tls = {
  caFile: "/certs/ca.crt",
  certFile: "/certs/client.crt",
  keyFile: "/certs/client.key",
};

function receiveEvent(message: string) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        dataMessage: { message, attachments: [] },
      },
    }),
  };
}

beforeEach(() => {
  sendMessageSignalMock.mockReset().mockResolvedValue({ messageId: "1" });
  sendTypingSignalMock.mockReset().mockResolvedValue(true);
  sendReadReceiptSignalMock.mockReset().mockResolvedValue(true);
});

describe("signal event handler TLS threading", () => {
  it("passes the TLS options to sendTypingSignal", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        baseUrl: "https://signal-proxy:8443",
        account: "+15559990000",
        historyLimit: 0,
        tls,
      }),
    );

    await handler(receiveEvent("hi"));

    expect(sendTypingSignalMock).toHaveBeenCalled();
    expect(sendTypingSignalMock.mock.calls[0]?.[1]).toMatchObject({ tls });
  });

  it("passes the TLS options to the pairing reply send", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        baseUrl: "https://signal-proxy:8443",
        account: "+15559990000",
        historyLimit: 0,
        dmPolicy: "pairing",
        allowFrom: [],
        tls,
      }),
    );

    await handler(receiveEvent("hello?"));

    expect(sendMessageSignalMock).toHaveBeenCalled();
    expect(sendMessageSignalMock.mock.calls[0]?.[2]).toMatchObject({ tls });
  });

  it("passes the TLS options to sendReadReceiptSignal", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        baseUrl: "https://signal-proxy:8443",
        account: "+15559990000",
        historyLimit: 0,
        sendReadReceipts: true,
        readReceiptsViaDaemon: false,
        tls,
      }),
    );

    await handler(receiveEvent("hi"));

    expect(sendReadReceiptSignalMock).toHaveBeenCalled();
    expect(sendReadReceiptSignalMock.mock.calls[0]?.[2]).toMatchObject({ tls });
  });

  it("sends no tls key at all when the channel is plaintext", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        baseUrl: "http://signal-api:8080",
        account: "+15559990000",
        historyLimit: 0,
        sendReadReceipts: true,
        readReceiptsViaDaemon: false,
      }),
    );

    await handler(receiveEvent("hi"));

    expect(sendTypingSignalMock.mock.calls[0]?.[1]).toMatchObject({ tls: undefined });
    expect(sendReadReceiptSignalMock.mock.calls[0]?.[2]).toMatchObject({ tls: undefined });
  });
});
