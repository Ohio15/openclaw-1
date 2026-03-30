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
    <div class="sub-tabs" style="display: flex; gap: 4px; margin-bottom: 18px;">
      ${SETTINGS_TABS.map(
        (tab) => html`
          <button
            class="sub-tab ${active === tab.id ? "active" : ""}"
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

export function renderAppearanceSettings(state: AppViewState) {
  const theme = state.settings?.theme ?? "system";
  return html`
    <div class="card">
      <div class="card-title">Appearance</div>
      <div class="card-sub">Theme and display preferences</div>
      <div class="row" style="margin-top: 16px; gap: 8px;">
        ${(["system", "light", "dark"] as const).map(
          (t) => html`
            <button
              class="btn ${theme === t ? "active" : ""}"
              @click=${() => {
                state.setTheme(t);
              }}
            >
              ${t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}
