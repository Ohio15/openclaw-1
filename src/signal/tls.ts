import { readFileSync } from "node:fs";
import { Agent, type Dispatcher } from "undici";

/**
 * Client-certificate material for reaching a Signal backend that sits behind an
 * mTLS front (e.g. an nginx sidecar that terminates TLS 1.3, demands a client
 * certificate signed by a private CA, and proxies plain HTTP to signal-api).
 *
 * All three paths are required together: a CA without a client keypair cannot
 * satisfy the sidecar's `ssl_verify_client on`, and a keypair without the CA
 * would have to fall back to the public trust store, which will never contain a
 * private CA. Partial config is rejected at load time rather than surfacing as
 * an opaque handshake failure at send time.
 */
export type SignalTlsOptions = {
  /** PEM CA bundle that signs the front's server certificate. */
  caFile: string;
  /** PEM client certificate presented during the handshake. */
  certFile: string;
  /** PEM private key for `certFile`. */
  keyFile: string;
};

/** The shape TLS paths take in `channels.signal` config. */
export type SignalTlsConfig = {
  tlsCaFile?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
};

type SignalTlsMaterial = {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
};

/** `RequestInit` plus undici's non-standard per-request dispatcher hook. */
export type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

const TLS_CONFIG_KEYS = ["tlsCaFile", "tlsCertFile", "tlsKeyFile"] as const;

// Keyed by the file paths, not by the options object: `resolveSignalAccount`
// rebuilds a merged config object on every call (every send, every probe tick),
// so object identity would defeat the cache entirely. Certificate rotation
// therefore needs a gateway restart to be picked up.
const materialCache = new Map<string, SignalTlsMaterial>();
const dispatcherCache = new Map<string, Dispatcher>();

function cacheKey(opts: SignalTlsOptions): string {
  return JSON.stringify([opts.caFile, opts.certFile, opts.keyFile]);
}

/**
 * Names of the TLS keys that are set, in config order. Exported so config
 * validation and this module report the same key names.
 */
export function listSignalTlsKeysSet(config: SignalTlsConfig | undefined): string[] {
  if (!config) {
    return [];
  }
  return TLS_CONFIG_KEYS.filter((key) => Boolean(config[key]?.trim()));
}

/**
 * Read the TLS block out of a resolved Signal account config.
 *
 * Returns `undefined` when no TLS key is set — the untouched, plaintext path
 * every existing deployment is on. Throws when the block is partial so a typo
 * cannot silently downgrade the transport back to plaintext.
 */
export function resolveSignalTlsOptions(
  config: SignalTlsConfig | undefined,
): SignalTlsOptions | undefined {
  const present = listSignalTlsKeysSet(config);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length !== TLS_CONFIG_KEYS.length) {
    const missing = TLS_CONFIG_KEYS.filter((key) => !present.includes(key));
    throw new Error(
      `Signal TLS config is incomplete: ${present.join(", ")} set but ${missing.join(", ")} missing. ` +
        "All of tlsCaFile, tlsCertFile, tlsKeyFile are required to present a client certificate.",
    );
  }
  return {
    caFile: (config as Required<SignalTlsConfig>).tlsCaFile.trim(),
    certFile: (config as Required<SignalTlsConfig>).tlsCertFile.trim(),
    keyFile: (config as Required<SignalTlsConfig>).tlsKeyFile.trim(),
  };
}

function readPem(label: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(
      `Signal TLS: cannot read ${label} "${path}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * CA/cert/key bytes for {@link SignalTlsOptions}, read eagerly and cached.
 *
 * Eager because a missing file must fail with the path in the message at the
 * first request, not as a TLS alert several layers down.
 */
export function readSignalTlsMaterial(opts: SignalTlsOptions): SignalTlsMaterial {
  const key = cacheKey(opts);
  const cached = materialCache.get(key);
  if (cached) {
    return cached;
  }
  const material: SignalTlsMaterial = {
    ca: readPem("CA file (tlsCaFile)", opts.caFile),
    cert: readPem("client certificate (tlsCertFile)", opts.certFile),
    key: readPem("client key (tlsKeyFile)", opts.keyFile),
  };
  materialCache.set(key, material);
  return material;
}

/**
 * undici {@link Agent} that presents the client certificate and trusts the
 * private CA, for use as `RequestInit.dispatcher`.
 *
 * Node's global fetch is undici-backed and honours this non-standard init key;
 * it is the only way to attach per-request TLS material without swapping the
 * process-wide global dispatcher (which would affect every other channel).
 * Cached because building an Agent per request would discard connection reuse
 * and re-run the handshake on every send.
 */
export function getSignalTlsDispatcher(opts: SignalTlsOptions): Dispatcher {
  const key = cacheKey(opts);
  const cached = dispatcherCache.get(key);
  if (cached) {
    return cached;
  }
  const material = readSignalTlsMaterial(opts);
  const agent = new Agent({
    connect: {
      ca: material.ca,
      cert: material.cert,
      key: material.key,
    },
  });
  dispatcherCache.set(key, agent);
  return agent;
}

/**
 * Fail closed when TLS material is configured but the URL cannot carry it.
 *
 * undici performs no handshake on an `http:` origin and `ws` drops tls options
 * on a `ws:` URL, so a client certificate paired with a plaintext base URL is
 * silently inert — the exact "configured mTLS, still shipping plaintext" state
 * this feature exists to prevent. Refuse the request instead.
 */
function assertSecureSignalOrigin(url: string, expected: "https:" | "wss:"): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Signal TLS: cannot determine the scheme of "${url}"`);
  }
  if (protocol === expected) {
    return;
  }
  throw new Error(
    `Signal TLS is configured (tlsCaFile/tlsCertFile/tlsKeyFile) but the target "${url}" is not ${expected.replace(":", "")}. ` +
      "Point channels.signal.httpUrl at the https:// endpoint of the TLS front, or remove the TLS options.",
  );
}

/**
 * Attach the client-certificate dispatcher to a request init.
 *
 * Returns `init` untouched when TLS is not configured, so the plaintext path is
 * byte-for-byte what it was before mTLS support existed. Throws when TLS is
 * configured against a non-https URL rather than issuing a plaintext request
 * that looks secure.
 */
export function withSignalTlsDispatcher(
  url: string,
  init: RequestInit,
  tls: SignalTlsOptions | undefined,
): RequestInitWithDispatcher {
  if (!tls) {
    return init;
  }
  assertSecureSignalOrigin(url, "https:");
  const withDispatcher: RequestInitWithDispatcher = {
    ...init,
    dispatcher: getSignalTlsDispatcher(tls),
  };
  return withDispatcher;
}

/**
 * ws client options carrying the same material as the HTTP dispatcher.
 *
 * Throws on a `ws:` URL for the same reason {@link withSignalTlsDispatcher}
 * does: `ws` would accept the options object and open a plaintext socket.
 */
export function signalTlsWsOptions(
  url: string,
  tls: SignalTlsOptions | undefined,
): { ca: Buffer; cert: Buffer; key: Buffer } | undefined {
  if (!tls) {
    return undefined;
  }
  assertSecureSignalOrigin(url, "wss:");
  return readSignalTlsMaterial(tls);
}

/** Test-only: drop cached material/dispatchers so file changes are re-read. */
export function resetSignalTlsCachesForTests(): void {
  materialCache.clear();
  for (const dispatcher of dispatcherCache.values()) {
    // Discarding an Agent without closing it leaks its keep-alive sockets for
    // the rest of the run; tests build many.
    void dispatcher.close().catch(() => {});
  }
  dispatcherCache.clear();
}
