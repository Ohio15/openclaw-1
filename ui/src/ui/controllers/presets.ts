import type { GatewayBrowserClient } from "../gateway.ts";

/**
 * Preset summary returned by preset.list gateway method.
 * Mirrors the shape produced in claude-gateway/index.ts registerGatewayMethod("preset.list").
 */
export type PresetSummary = {
  name: string;
  display_name: string;
  description: string;
  schedule?: string;
  tags: string[];
  has_mcp: boolean;
};

/**
 * Full preset detail returned by preset.get gateway method.
 * Mirrors PresetConfig from claude-gateway/src/types.ts.
 */
export type PresetDetail = {
  name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  allowed_tools: string[];
  mcp_config?: string;
  working_directory?: string;
  schedule?: string;
  tags: string[];
  max_turns?: number;
};

export type PresetRunResponse = {
  preset: string;
  cronJobId: string;
  oneOff?: boolean;
  result?: unknown;
};

export type PresetReloadResponse = {
  presetsLoaded: number;
  cronSync: unknown;
};

export type PresetsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  presetsLoading: boolean;
  presets: PresetSummary[];
  presetsError: string | null;
  presetsDetailCache: Map<string, PresetDetail>;
  presetsDetailLoading: string | null;
  presetsRunning: string | null;
  presetsReloading: boolean;
};

export async function fetchPresets(state: PresetsState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.presetsLoading) {
    return;
  }
  state.presetsLoading = true;
  state.presetsError = null;
  try {
    const res = await state.client.request<{ presets?: PresetSummary[] }>("preset.list", {});
    state.presets = Array.isArray(res.presets) ? res.presets : [];
  } catch (err) {
    state.presetsError = String(err);
  } finally {
    state.presetsLoading = false;
  }
}

export async function fetchPreset(state: PresetsState, name: string): Promise<PresetDetail | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  // Return cached detail if available
  const cached = state.presetsDetailCache.get(name);
  if (cached) {
    return cached;
  }
  state.presetsDetailLoading = name;
  state.presetsError = null;
  try {
    const res = await state.client.request<{ preset?: PresetDetail }>("preset.get", { name });
    if (res.preset) {
      state.presetsDetailCache.set(name, res.preset);
      return res.preset;
    }
    return null;
  } catch (err) {
    state.presetsError = String(err);
    return null;
  } finally {
    state.presetsDetailLoading = null;
  }
}

export async function runPreset(state: PresetsState, name: string): Promise<void> {
  if (!state.client || !state.connected || state.presetsRunning) {
    return;
  }
  state.presetsRunning = name;
  state.presetsError = null;
  try {
    await state.client.request<PresetRunResponse>("preset.run", { name });
  } catch (err) {
    state.presetsError = String(err);
  } finally {
    state.presetsRunning = null;
  }
}

export async function reloadPresets(state: PresetsState): Promise<void> {
  if (!state.client || !state.connected || state.presetsReloading) {
    return;
  }
  state.presetsReloading = true;
  state.presetsError = null;
  try {
    await state.client.request<PresetReloadResponse>("preset.reload", {});
    // Clear detail cache since presets may have changed on disk
    state.presetsDetailCache.clear();
    // Re-fetch the list
    await fetchPresets(state);
  } catch (err) {
    state.presetsError = String(err);
  } finally {
    state.presetsReloading = false;
  }
}
