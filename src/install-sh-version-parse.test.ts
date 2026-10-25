import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The installer smoke images (scripts/docker/install-sh-*) compare the installed
// CLI's `--version` against the npm registry version through this helper.
const HELPER_PATH = path.join(
  process.cwd(),
  "scripts",
  "docker",
  "install-sh-common",
  "version-parse.sh",
);

type BashResult = { status: number | null; stdout: string; stderr: string };

function runHelper(script: string, env: Record<string, string>): BashResult {
  const result = spawnSync("bash", ["-c", `source "$HELPER_PATH"\n${script}`], {
    encoding: "utf-8",
    env: { ...process.env, ...env, HELPER_PATH },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parse(raw: string): BashResult {
  return runHelper('parse_openclaw_cli_version "$RAW_VERSION"', { RAW_VERSION: raw });
}

// Windows `bash` may resolve to WSL, which cannot see this checkout's paths; the
// helper only ever runs inside Linux containers, so exercise it where it runs.
describe.runIf(process.platform !== "win32")("install-sh version-parse.sh", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function fakeCli(body: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-version-parse-"));
    tempRoots.push(root);
    const cliPath = path.join(root, "openclaw");
    fs.writeFileSync(cliPath, `#!/usr/bin/env bash\n${body}\n`, "utf-8");
    fs.chmodSync(cliPath, 0o755);
    return cliPath;
  }

  it.each([
    ["OpenClaw 2026.10.7 (157d8c2)", "2026.10.7"],
    ["OpenClaw 2026.10.7", "2026.10.7"],
    ["OpenClaw 2026.10.7 (157d8c2a9f0e1b2c3d4e5f60718293a4b5c6d7e8)", "2026.10.7"],
    ["OpenClaw 2026.10.7-beta.1 (abcdef0)", "2026.10.7-beta.1"],
    ["OpenClaw 2026.10.7\r", "2026.10.7"],
    ["2026.2.46", "2026.2.46"],
  ])("accepts %j as %s", (raw, expected) => {
    const result = parse(raw);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.each([
    "",
    "error: unknown option '--version'",
    "openclaw 2026.10.7 (157d8c2)",
    "Clawdbot 2026.10.7",
    "OpenClaw 2026.10.7 (157D8C2)",
    "OpenClaw 2026.10.7 (157d8c)",
    "OpenClaw 2026.10.7 (157d8c2) extra",
    "OpenClaw  2026.10.7",
    "OpenClaw 2026.10",
    "v2026.10.7",
    "installed openclaw@2026.10.7",
  ])("rejects %j", (raw) => {
    const result = parse(raw);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unrecognised 'openclaw --version' output");
  });

  it("reads and parses the first line of a decorated CLI's --version", () => {
    const cliPath = fakeCli(
      '[[ "$1" == "--version" ]] || exit 64\nprintf "OpenClaw 2026.10.7 (157d8c2)\\nsecond line\\n"',
    );
    const result = runHelper('read_openclaw_cli_version "$CLI_PATH"', { CLI_PATH: cliPath });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026.10.7");
  });

  it("fails when the CLI cannot report a version", () => {
    const cliPath = fakeCli('echo "boom" >&2\nexit 3');
    const result = runHelper('read_openclaw_cli_version "$CLI_PATH"', { CLI_PATH: cliPath });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unrecognised 'openclaw --version' output: ''");
  });

  it("aborts a set -e smoke script on unrecognised output", () => {
    const cliPath = fakeCli('echo "something else entirely"');
    const result = runHelper(
      'set -euo pipefail\nINSTALLED="$(read_openclaw_cli_version "$CLI_PATH")"\necho "reached $INSTALLED"',
      { CLI_PATH: cliPath },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("reached");
  });
});
