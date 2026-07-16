import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HIGH #4 — port pre-flight + exit handler binding for spawnSignalDaemon.

const childProcessHoist = vi.hoisted(() => {
  const spawnMock = vi.fn();
  return { spawnMock };
});

vi.mock("node:child_process", () => ({
  spawn: childProcessHoist.spawnMock,
}));

import { type ProbeConnection, spawnSignalDaemon } from "./daemon.js";

type ExitArgs = [code: number | null, signal: NodeJS.Signals | null];

type FakeChild = {
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  emitExit: (...args: ExitArgs) => void;
};

function createFakeChild(): FakeChild {
  let exitListener: ((...args: ExitArgs) => void) | null = null;
  const noopStream = { on: vi.fn() };
  return {
    pid: 12345,
    killed: false,
    kill: vi.fn(),
    on: vi.fn((event: string, fn: (...args: ExitArgs) => void) => {
      if (event === "exit") {
        exitListener = fn;
      }
    }),
    stdout: noopStream,
    stderr: noopStream,
    emitExit: (...args: ExitArgs) => exitListener?.(...args),
  };
}

const log = vi.fn();
const error = vi.fn();
const runtime = {
  log,
  error,
  exit: ((code: number): never => {
    throw new Error(`unexpected exit ${code}`);
  }) as (code: number) => never,
};

beforeEach(() => {
  log.mockReset();
  error.mockReset();
  childProcessHoist.spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HIGH #4 — port pre-flight before spawning signal-cli daemon", () => {
  it("skips spawn and returns adopted handle when port is already listening", async () => {
    const probe: ProbeConnection = vi.fn(async () => true);
    const handle = await spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime,
      probeConnection: probe,
    });

    expect(probe).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 8080,
      timeoutMs: expect.any(Number),
    });
    expect(childProcessHoist.spawnMock).not.toHaveBeenCalled();
    expect(handle.adopted).toBe(true);
    expect(handle.exited).toBe(false);
    expect(handle.pid).toBeUndefined();
    // stop() must be a no-op for adopted handles — we don't own the process.
    handle.stop();
    // No throw, no spawn side effect.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("already listening on 127.0.0.1:8080"),
    );
  });

  it("proceeds with spawn when port probe fails (no listener)", async () => {
    const probe: ProbeConnection = vi.fn(async () => false);
    const child = createFakeChild();
    childProcessHoist.spawnMock.mockReturnValueOnce(child);

    const handle = await spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime,
      probeConnection: probe,
    });

    expect(probe).toHaveBeenCalled();
    expect(childProcessHoist.spawnMock).toHaveBeenCalledTimes(1);
    expect(handle.adopted).toBe(false);
    expect(handle.exited).toBe(false);
    expect(handle.pid).toBe(12345);
  });

  it("binds child.on('exit') and flips exited flag on child exit", async () => {
    const probe: ProbeConnection = vi.fn(async () => false);
    const child = createFakeChild();
    childProcessHoist.spawnMock.mockReturnValueOnce(child);

    const handle = await spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime,
      probeConnection: probe,
    });

    expect(handle.exited).toBe(false);

    // Simulate signal-cli crashing with non-zero exit code mid-readiness-wait.
    child.emitExit(137, null);

    expect(handle.exited).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli daemon exited unexpectedly"),
    );
  });

  it("logs (not errors) on graceful SIGTERM exit", async () => {
    const probe: ProbeConnection = vi.fn(async () => false);
    const child = createFakeChild();
    childProcessHoist.spawnMock.mockReturnValueOnce(child);

    const handle = await spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime,
      probeConnection: probe,
    });

    child.emitExit(null, "SIGTERM");

    expect(handle.exited).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli daemon exited"),
    );
  });

  it("stop() is a no-op once child has exited", async () => {
    const probe: ProbeConnection = vi.fn(async () => false);
    const child = createFakeChild();
    childProcessHoist.spawnMock.mockReturnValueOnce(child);

    const handle = await spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime,
      probeConnection: probe,
    });

    child.emitExit(0, null);
    handle.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
