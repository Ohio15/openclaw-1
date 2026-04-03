import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPresetLoader } from "../src/preset-loader.js";

describe("PresetLoader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-preset-loader-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  function writeYaml(dir: string, filename: string, content: string): void {
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
  }

  it("loads YAML files from directory", () => {
    writeYaml(tmpDir, "monitor.yml", `
name: monitor
display_name: System Monitor
description: Monitors system health
system_prompt: You monitor things
allowed_tools:
  - bash
tags:
  - ops
`);
    writeYaml(tmpDir, "deploy.yaml", `
name: deploy
display_name: Deployer
description: Deploys services
system_prompt: You deploy things
allowed_tools:
  - bash
  - git
tags:
  - ci
`);

    const store = createPresetLoader(tmpDir, silentLogger);
    const all = store.listAll();

    expect(all).toHaveLength(2);
    expect(store.get("monitor")).toBeDefined();
    expect(store.get("deploy")).toBeDefined();
    expect(store.get("monitor")!.display_name).toBe("System Monitor");
    expect(store.get("deploy")!.allowed_tools).toEqual(["bash", "git"]);
  });

  it("handles env var substitution with ${VAR} and ${VAR:default}", () => {
    process.env.TEST_PRESET_TOKEN = "secret-abc";

    writeYaml(tmpDir, "envtest.yml", `
name: envtest
display_name: Env Test
description: Uses env vars
system_prompt: Token is \${TEST_PRESET_TOKEN} and fallback is \${MISSING_VAR:fallback-value}
allowed_tools: []
tags: []
`);

    const store = createPresetLoader(tmpDir, silentLogger);
    const preset = store.get("envtest");

    expect(preset).toBeDefined();
    expect(preset!.system_prompt).toBe("Token is secret-abc and fallback is fallback-value");

    delete process.env.TEST_PRESET_TOKEN;
  });

  it("handles missing env var with no default — leaves as-is", () => {
    // Ensure the var does not exist
    delete process.env.TOTALLY_MISSING_PRESET_VAR;

    writeYaml(tmpDir, "missing-env.yml", `
name: missing-env
display_name: Missing Env
description: Has unresolved var
system_prompt: Value is \${TOTALLY_MISSING_PRESET_VAR}
allowed_tools: []
tags: []
`);

    const store = createPresetLoader(tmpDir, silentLogger);
    const preset = store.get("missing-env");

    expect(preset).toBeDefined();
    expect(preset!.system_prompt).toBe("Value is ${TOTALLY_MISSING_PRESET_VAR}");
  });

  it("skips non-YAML files", () => {
    writeYaml(tmpDir, "valid.yml", `
name: valid
display_name: Valid
description: A valid preset
system_prompt: Hello
allowed_tools: []
tags: []
`);
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "This is not a preset");
    fs.writeFileSync(path.join(tmpDir, "config.json"), '{"not": "a preset"}');
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "# Notes");

    const store = createPresetLoader(tmpDir, silentLogger);
    const all = store.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("valid");
  });

  it("handles empty directory", () => {
    const store = createPresetLoader(tmpDir, silentLogger);
    const all = store.listAll();

    expect(all).toHaveLength(0);
    expect(store.presets.size).toBe(0);
  });

  it("handles missing directory", () => {
    const warnings: unknown[][] = [];
    const logger = {
      info: () => {},
      warn: (...args: unknown[]) => { warnings.push(args); },
      error: () => {},
    };

    const nonExistent = path.join(tmpDir, "does-not-exist");
    const store = createPresetLoader(nonExistent, logger);

    expect(store.listAll()).toHaveLength(0);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(String(warnings[0])).toContain("not found");
  });

  it("detects scheduled presets", () => {
    writeYaml(tmpDir, "scheduled.yml", `
name: scheduled-job
display_name: Scheduled Job
description: Runs on a cron
system_prompt: Do things
allowed_tools: []
schedule: "0 * * * *"
tags: []
`);
    writeYaml(tmpDir, "unscheduled.yml", `
name: unscheduled-job
display_name: Unscheduled Job
description: No schedule
system_prompt: Do other things
allowed_tools: []
tags: []
`);

    const store = createPresetLoader(tmpDir, silentLogger);
    const scheduled = store.scheduled();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toBe("scheduled-job");
    expect(scheduled[0].schedule).toBe("0 * * * *");
  });

  it("reload picks up new files", () => {
    writeYaml(tmpDir, "first.yml", `
name: first
display_name: First
description: First preset
system_prompt: First
allowed_tools: []
tags: []
`);

    const store = createPresetLoader(tmpDir, silentLogger);
    expect(store.listAll()).toHaveLength(1);

    // Add a new file after initial load
    writeYaml(tmpDir, "second.yml", `
name: second
display_name: Second
description: Second preset
system_prompt: Second
allowed_tools: []
tags: []
`);

    store.reload();
    expect(store.listAll()).toHaveLength(2);
    expect(store.get("second")).toBeDefined();
    expect(store.get("second")!.display_name).toBe("Second");
  });
});
