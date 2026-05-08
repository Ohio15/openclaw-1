import { spawn } from "node:child_process";
import net from "node:net";
import type { RuntimeEnv } from "../runtime.js";

export type SignalDaemonOpts = {
  cliPath: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  runtime?: RuntimeEnv;
  // Optional injection seam used by tests to swap the TCP probe.
  probeConnection?: ProbeConnection;
};

export type SignalDaemonHandle = {
  pid?: number;
  stop: () => void;
  /**
   * True iff the underlying child has exited (or was never spawned because
   * a healthy daemon was already listening). Consumers polling readiness
   * can fail-fast against this flag instead of timing out.
   */
  readonly exited: boolean;
  /** True iff this handle wraps a process we did not spawn. */
  readonly adopted: boolean;
};

export type ProbeConnection = (params: {
  host: string;
  port: number;
  timeoutMs: number;
}) => Promise<boolean>;

const DEFAULT_PROBE_TIMEOUT_MS = 200;

/**
 * Default TCP-connect probe used to detect a leftover signal-cli daemon
 * (e.g. after a container restart that didn't release the port). Resolves
 * true iff a TCP handshake completes within `timeoutMs`.
 */
export const probeSignalDaemonPort: ProbeConnection = ({ host, port, timeoutMs }) =>
  new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    try {
      socket.connect({ host, port });
    } catch {
      settle(false);
    }
  });

export function classifySignalCliLogLine(line: string): "log" | "error" | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  // signal-cli commonly writes all logs to stderr; treat severity explicitly.
  if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) {
    return "error";
  }
  // Some signal-cli failures are not tagged with WARN/ERROR but should still be surfaced loudly.
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return "error";
  }
  return "log";
}

function bindSignalCliOutput(params: {
  stream: NodeJS.ReadableStream | null | undefined;
  log: (message: string) => void;
  error: (message: string) => void;
}): void {
  params.stream?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") {
        params.log(`signal-cli: ${line.trim()}`);
      } else if (kind === "error") {
        params.error(`signal-cli: ${line.trim()}`);
      }
    }
  });
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  args.push("--http", `${opts.httpHost}:${opts.httpPort}`);
  args.push("--no-receive-stdout");

  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) {
    args.push("--ignore-attachments");
  }
  if (opts.ignoreStories) {
    args.push("--ignore-stories");
  }
  if (opts.sendReadReceipts) {
    args.push("--send-read-receipts");
  }

  return args;
}

export async function spawnSignalDaemon(opts: SignalDaemonOpts): Promise<SignalDaemonHandle> {
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});

  // HIGH #4: container-restart leftover. If a previous gateway crashed
  // without releasing port 8080 (or a sibling container is already running
  // signal-cli), spawn() will succeed but the new daemon will fail to
  // bind, log a port-in-use exception, and exit. The readiness wait then
  // burns its full 30s timeout. Probe the port BEFORE spawning; if a
  // service is already listening, adopt it as a non-stoppable handle —
  // we cannot SIGTERM a process we do not own.
  const probe = opts.probeConnection ?? probeSignalDaemonPort;
  const portInUse = await probe({
    host: opts.httpHost,
    port: opts.httpPort,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (portInUse) {
    log(
      `signal-cli daemon already listening on ${opts.httpHost}:${opts.httpPort}; adopting existing process (stop is a no-op).`,
    );
    return {
      pid: undefined,
      stop: () => {
        // Intentional no-op. We did not spawn this child; we cannot
        // kill it. The readiness wait will probe the existing daemon.
      },
      exited: false,
      adopted: true,
    };
  }

  const args = buildDaemonArgs(opts);
  const child = spawn(opts.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;

  bindSignalCliOutput({ stream: child.stdout, log, error });
  bindSignalCliOutput({ stream: child.stderr, log, error });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
  });
  // HIGH #4 + HIGH #6: bind exit handler. Surfaces unexpected daemon
  // crashes immediately instead of letting the readiness loop time out.
  // The `exited` flag is what `waitForSignalDaemonReady` (HIGH #6)
  // consults so it can fail fast rather than poll the dead port.
  child.on("exit", (code, signal) => {
    exited = true;
    const detail = signal ? `signal ${signal}` : `code ${code ?? "<unknown>"}`;
    if (code === 0 || signal === "SIGTERM") {
      log(`signal-cli daemon exited (${detail})`);
    } else {
      error(`signal-cli daemon exited unexpectedly (${detail})`);
    }
  });

  return {
    pid: child.pid ?? undefined,
    stop: () => {
      if (!child.killed && !exited) {
        child.kill("SIGTERM");
      }
    },
    get exited() {
      return exited;
    },
    adopted: false,
  };
}
