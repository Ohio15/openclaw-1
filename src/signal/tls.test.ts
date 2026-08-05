import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  getSignalTlsDispatcher,
  readSignalTlsMaterial,
  resetSignalTlsCachesForTests,
  resolveSignalTlsOptions,
  signalTlsWsOptions,
  withSignalTlsDispatcher,
} from "./tls.js";

// The PEM bytes are never parsed here: undici stores `connect` options until a
// socket is actually opened, so placeholder content exercises the wiring
// (read + cache + attach) without needing a real CA.
const dir = mkdtempSync(join(tmpdir(), "signal-tls-"));
const caFile = join(dir, "ca.crt");
const certFile = join(dir, "client.crt");
const keyFile = join(dir, "client.key");
writeFileSync(caFile, "ca-pem");
writeFileSync(certFile, "cert-pem");
writeFileSync(keyFile, "key-pem");

const files = { tlsCaFile: caFile, tlsCertFile: certFile, tlsKeyFile: keyFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSignalTlsCachesForTests();
});

describe("resolveSignalTlsOptions", () => {
  it("returns undefined when no TLS key is set (the unchanged plaintext path)", () => {
    expect(resolveSignalTlsOptions(undefined)).toBeUndefined();
    expect(resolveSignalTlsOptions({})).toBeUndefined();
    expect(resolveSignalTlsOptions({ tlsCaFile: "   " })).toBeUndefined();
  });

  it("resolves all three paths when the block is complete", () => {
    expect(resolveSignalTlsOptions(files)).toEqual({
      caFile,
      certFile,
      keyFile,
    });
  });

  it("trims surrounding whitespace from the configured paths", () => {
    expect(
      resolveSignalTlsOptions({
        tlsCaFile: ` ${caFile} `,
        tlsCertFile: ` ${certFile} `,
        tlsKeyFile: ` ${keyFile} `,
      }),
    ).toEqual({ caFile, certFile, keyFile });
  });

  it("rejects a partial block naming the missing keys", () => {
    expect(() => resolveSignalTlsOptions({ tlsCaFile: caFile })).toThrow(
      /tlsCaFile set but tlsCertFile, tlsKeyFile missing/,
    );
    expect(() => resolveSignalTlsOptions({ tlsCertFile: certFile, tlsKeyFile: keyFile })).toThrow(
      /tlsCaFile missing/,
    );
  });
});

describe("readSignalTlsMaterial", () => {
  it("reads the PEM bytes eagerly", () => {
    const material = readSignalTlsMaterial({ caFile, certFile, keyFile });
    expect(material.ca.toString()).toBe("ca-pem");
    expect(material.cert.toString()).toBe("cert-pem");
    expect(material.key.toString()).toBe("key-pem");
  });

  it("names the unreadable file and which option it came from", () => {
    const missing = join(dir, "nope.crt");
    expect(() => readSignalTlsMaterial({ caFile: missing, certFile, keyFile })).toThrow(
      new RegExp(`cannot read CA file \\(tlsCaFile\\) "${missing.replace(/\\/g, "\\\\")}"`),
    );
  });

  it("caches by path so reconnects do not re-read from disk", () => {
    const first = readSignalTlsMaterial({ caFile, certFile, keyFile });
    const second = readSignalTlsMaterial({ caFile, certFile, keyFile });
    expect(second).toBe(first);
  });
});

describe("getSignalTlsDispatcher", () => {
  it("builds one dispatcher per options object, not per request", () => {
    const first = getSignalTlsDispatcher({ caFile, certFile, keyFile });
    const second = getSignalTlsDispatcher({ caFile, certFile, keyFile });
    expect(second).toBe(first);
  });

  it("builds a distinct dispatcher for a different certificate set", () => {
    const otherCert = join(dir, "other.crt");
    writeFileSync(otherCert, "other-cert-pem");
    const first = getSignalTlsDispatcher({ caFile, certFile, keyFile });
    const second = getSignalTlsDispatcher({ caFile, certFile: otherCert, keyFile });
    expect(second).not.toBe(first);
  });
});

describe("withSignalTlsDispatcher", () => {
  it("returns the init untouched when TLS is not configured", () => {
    const init = { method: "GET" as const };
    const result = withSignalTlsDispatcher("http://signal-api:8080/v1/health", init, undefined);
    expect(result).toBe(init);
    expect(result).not.toHaveProperty("dispatcher");
  });

  it("attaches the cached dispatcher without disturbing the other init keys", () => {
    const init = { method: "POST" as const, headers: { "Content-Type": "application/json" } };
    const result = withSignalTlsDispatcher("https://signal-proxy:8443/v2/send", init, {
      caFile,
      certFile,
      keyFile,
    });
    expect(result.method).toBe("POST");
    expect(result.headers).toEqual({ "Content-Type": "application/json" });
    expect(result.dispatcher).toBe(getSignalTlsDispatcher({ caFile, certFile, keyFile }));
  });

  it("refuses a plaintext origin instead of silently dropping the certificate", () => {
    expect(() =>
      withSignalTlsDispatcher(
        "http://signal-api:8080/v2/send",
        { method: "POST" },
        { caFile, certFile, keyFile },
      ),
    ).toThrow(/is not https/);
  });
});

describe("signalTlsWsOptions", () => {
  it("returns undefined when TLS is not configured", () => {
    expect(signalTlsWsOptions("ws://signal-api:8080/v1/receive/x", undefined)).toBeUndefined();
  });

  it("returns the material for a wss url", () => {
    const options = signalTlsWsOptions("wss://signal-proxy:8443/v1/receive/x", {
      caFile,
      certFile,
      keyFile,
    });
    expect(options?.ca.toString()).toBe("ca-pem");
  });

  it("refuses a plaintext websocket instead of opening one without the certificate", () => {
    expect(() =>
      signalTlsWsOptions("ws://signal-api:8080/v1/receive/x", { caFile, certFile, keyFile }),
    ).toThrow(/is not wss/);
  });
});
