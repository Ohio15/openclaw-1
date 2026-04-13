/**
 * Loads agent preset YAML files from a directory.
 *
 * Supports environment variable substitution: ${VAR_NAME} or ${VAR_NAME:default}
 * Port of ClaudeGateway app/services/preset_loader.py
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { PresetConfig } from "./types.js";

const ENV_VAR_PATTERN = /\$\{(\w+)(?::([^}]*))?\}/g;

function envReplacer(_match: string, varName: string, defaultValue?: string): string {
  const value = process.env[varName];
  if (value !== undefined) return value;
  if (defaultValue !== undefined) return defaultValue;
  return _match; // Leave as-is if no env var and no default
}

function loadFile(filePath: string): PresetConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  const resolved = raw.replace(ENV_VAR_PATTERN, envReplacer);
  const data = yaml.load(resolved) as Record<string, unknown>;

  return {
    name: data.name as string,
    display_name: (data.display_name as string) ?? (data.name as string),
    description: (data.description as string) ?? "",
    system_prompt: (data.system_prompt as string) ?? "",
    allowed_tools: (data.allowed_tools as string[]) ?? [],
    mcp_config: data.mcp_config as string | undefined,
    working_directory: data.working_directory as string | undefined,
    schedule: data.schedule as string | undefined,
    tags: (data.tags as string[]) ?? [],
    max_turns: data.max_turns as number | undefined,
  };
}

export type PresetStore = {
  presets: Map<string, PresetConfig>;
  get: (name: string) => PresetConfig | undefined;
  listAll: () => PresetConfig[];
  scheduled: () => PresetConfig[];
  reload: () => void;
};

export function createPresetLoader(presetsDir: string, logger?: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }): PresetStore {
  const presets = new Map<string, PresetConfig>();
  const log = logger ?? console;

  function loadAll(): void {
    presets.clear();

    const resolvedDir = path.resolve(presetsDir);
    if (!fs.existsSync(resolvedDir)) {
      log.warn(`[claude-gateway] Presets directory not found: ${resolvedDir}`);
      return;
    }

    const files = fs.readdirSync(resolvedDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();

    for (const file of files) {
      const filePath = path.join(resolvedDir, file);
      try {
        const preset = loadFile(filePath);
        presets.set(preset.name, preset);
        log.info(`[claude-gateway] Loaded preset: ${preset.name} (${preset.display_name})`);
      } catch (e) {
        log.error(`[claude-gateway] Failed to load preset ${file}: ${e}`);
      }
    }

    log.info(`[claude-gateway] Preset loading complete: ${presets.size} presets`);
  }

  // Initial load
  loadAll();

  return {
    presets,
    get: (name: string) => presets.get(name),
    listAll: () => [...presets.values()],
    scheduled: () => [...presets.values()].filter((p) => p.schedule),
    reload: loadAll,
  };
}
