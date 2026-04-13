import { html } from "lit";
import type { AppViewState } from "../app-view-state.ts";

const SETTINGS_TABS = [
  { id: "connection", label: "Connection" },
  { id: "config", label: "Config" },
  { id: "debug", label: "Debug" },
  { id: "logs", label: "Logs" },
  { id: "appearance", label: "Appearance" },
] as const;

export function renderSettingsSubTabs(state: AppViewState) {
  const active = state.settingsSubTab || "config";

  return html`
    <div class="settings-subtabs">
      ${SETTINGS_TABS.map(
        (tab) => html`
          <button
            class="settings-subtab ${active === tab.id ? "settings-subtab--active" : ""}"
            @click=${() => {
              (state as any).settingsSubTab = tab.id;
            }}
          >
            ${tab.label}
          </button>
        `,
      )}
    </div>
  `;
}

const THEME_OPTIONS = [
  { id: "system" as const, label: "System", description: "Match your OS preference" },
  { id: "light" as const, label: "Light", description: "Light background, dark text" },
  { id: "dark" as const, label: "Dark", description: "Dark background, light text" },
];

export function renderAppearanceSettings(state: AppViewState) {
  const theme = state.settings?.theme ?? "system";
  const showThinking = state.settings?.chatShowThinking ?? true;
  const focusMode = state.settings?.chatFocusMode ?? false;

  return html`
    <div class="card">
      <div class="card-title">Theme</div>
      <div class="card-sub">Choose how OpenClaw looks on this device.</div>
      <div class="grid grid-cols-3" style="margin-top: 16px;">
        ${THEME_OPTIONS.map(
          (t) => html`
            <button
              class="stat"
              style="cursor: pointer; text-align: center; transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); ${theme === t.id ? "border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent);" : ""}"
              @click=${() => state.setTheme(t.id)}
            >
              <div class="stat-label">${t.label}</div>
              <div style="font-size: 13px; margin-top: 4px; color: var(--muted);">${t.description}</div>
            </button>
          `,
        )}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Chat display</div>
      <div class="card-sub">Control how chat content is rendered.</div>
      <div class="stack" style="margin-top: 16px;">
        <label class="row" style="justify-content: space-between; cursor: pointer;">
          <div>
            <div style="font-weight: 500;">Show thinking</div>
            <div class="card-sub" style="margin-top: 2px;">Display the model's reasoning process in chat.</div>
          </div>
          <input
            type="checkbox"
            .checked=${showThinking}
            @change=${() => {
              state.applySettings({
                ...state.settings,
                chatShowThinking: !showThinking,
              });
            }}
          />
        </label>
        <label class="row" style="justify-content: space-between; cursor: pointer; padding-top: 12px; border-top: 1px solid var(--border);">
          <div>
            <div style="font-weight: 500;">Focus mode</div>
            <div class="card-sub" style="margin-top: 2px;">Hide the sidebar and header for a distraction-free chat experience.</div>
          </div>
          <input
            type="checkbox"
            .checked=${focusMode}
            @change=${() => {
              state.applySettings({
                ...state.settings,
                chatFocusMode: !focusMode,
              });
            }}
          />
        </label>
      </div>
    </div>
  `;
}
