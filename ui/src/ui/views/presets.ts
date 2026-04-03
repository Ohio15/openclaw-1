import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import type { PresetDetail, PresetSummary } from "../controllers/presets.ts";

export type PresetsProps = {
  loading: boolean;
  presets: PresetSummary[];
  error: string | null;
  filter: string;
  expandedPreset: string | null;
  expandedDetail: PresetDetail | null;
  detailLoading: string | null;
  running: string | null;
  reloading: boolean;
  onFilterChange: (value: string) => void;
  onReload: () => void;
  onRun: (name: string) => void;
  onToggleExpand: (name: string) => void;
};

function matchesFilter(preset: PresetSummary, filter: string): boolean {
  if (!filter) {
    return true;
  }
  const lower = filter.toLowerCase();
  if (preset.display_name.toLowerCase().includes(lower)) {
    return true;
  }
  if (preset.name.toLowerCase().includes(lower)) {
    return true;
  }
  if (preset.description.toLowerCase().includes(lower)) {
    return true;
  }
  if (preset.tags.some((tag) => tag.toLowerCase().includes(lower))) {
    return true;
  }
  return false;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}

function renderPresetCard(preset: PresetSummary, props: PresetsProps): TemplateResult {
  const isExpanded = props.expandedPreset === preset.name;
  const isRunning = props.running === preset.name;
  const isDetailLoading = props.detailLoading === preset.name;
  const detail = isExpanded ? props.expandedDetail : null;

  return html`
    <div class="list-item" style="flex-direction: column; align-items: stretch;">
      <div style="display: flex; align-items: flex-start; gap: 12px;">
        <div class="list-main" style="flex: 1; min-width: 0;">
          <div class="list-title">${preset.display_name || preset.name}</div>
          <div class="list-sub">${preset.description}</div>
          ${preset.schedule
            ? html`<div class="muted" style="margin-top: 4px; font-family: var(--mono); font-size: 12px;">
                Schedule: ${preset.schedule}
              </div>`
            : nothing}
          ${preset.tags.length > 0
            ? html`
                <div class="chip-row" style="margin-top: 6px;">
                  ${preset.tags.map(
                    (tag) => html`<span class="chip">${tag}</span>`,
                  )}
                  ${preset.has_mcp
                    ? html`<span class="chip chip-ok">MCP</span>`
                    : nothing}
                </div>
              `
            : preset.has_mcp
              ? html`
                  <div class="chip-row" style="margin-top: 6px;">
                    <span class="chip chip-ok">MCP</span>
                  </div>
                `
              : nothing}
        </div>
        <div class="list-meta" style="display: flex; gap: 6px; flex-shrink: 0;">
          <button
            class="btn"
            ?disabled=${!!props.running}
            @click=${(e: Event) => {
              e.stopPropagation();
              props.onToggleExpand(preset.name);
            }}
          >
            ${isExpanded ? "Collapse" : "Details"}
          </button>
          <button
            class="btn primary"
            ?disabled=${isRunning || !!props.running}
            @click=${(e: Event) => {
              e.stopPropagation();
              props.onRun(preset.name);
            }}
          >
            ${isRunning ? "Running..." : "Run"}
          </button>
        </div>
      </div>
      ${isExpanded
        ? html`
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
              ${isDetailLoading
                ? html`<div class="muted">Loading details...</div>`
                : detail
                  ? renderPresetDetail(detail)
                  : html`<div class="muted">Loading...</div>`}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderPresetDetail(detail: PresetDetail): TemplateResult {
  return html`
    <div style="display: flex; flex-direction: column; gap: 10px;">
      ${detail.system_prompt
        ? html`
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px;">
                System Prompt
              </div>
              <div style="font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--text); background: var(--bg-muted); padding: 8px 10px; border-radius: var(--radius-sm); white-space: pre-wrap; max-height: 200px; overflow-y: auto;">
                ${truncateText(detail.system_prompt, 1000)}
              </div>
            </div>
          `
        : nothing}
      ${detail.allowed_tools.length > 0
        ? html`
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px;">
                Tools (${detail.allowed_tools.length})
              </div>
              <div class="chip-row">
                ${detail.allowed_tools.map(
                  (tool) => html`<span class="chip">${tool}</span>`,
                )}
              </div>
            </div>
          `
        : nothing}
      ${detail.mcp_config
        ? html`
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px;">
                MCP Config
              </div>
              <div style="font-family: var(--mono); font-size: 12px; color: var(--text);">
                ${detail.mcp_config}
              </div>
            </div>
          `
        : nothing}
      ${detail.working_directory
        ? html`
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px;">
                Working Directory
              </div>
              <div style="font-family: var(--mono); font-size: 12px; color: var(--text);">
                ${detail.working_directory}
              </div>
            </div>
          `
        : nothing}
      ${detail.max_turns != null
        ? html`
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px;">
                Max Turns
              </div>
              <div style="font-size: 13px; color: var(--text);">
                ${detail.max_turns}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderPresets(props: PresetsProps): TemplateResult {
  const filtered = props.presets.filter((p) => matchesFilter(p, props.filter));
  const scheduledCount = props.presets.filter((p) => p.schedule).length;

  return html`
    <section class="card">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <div class="card-title">Presets</div>
          <div class="card-sub">
            ${props.presets.length} preset${props.presets.length !== 1 ? "s" : ""} loaded${scheduledCount > 0 ? `, ${scheduledCount} scheduled` : ""}.
          </div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn"
            ?disabled=${props.reloading || props.loading}
            @click=${props.onReload}
          >
            ${props.reloading ? "Reloading..." : "Reload from Disk"}
          </button>
        </div>
      </div>
      ${props.error
        ? html`<div class="muted" style="margin-top: 8px; color: var(--danger);">${props.error}</div>`
        : nothing}
    </section>

    <section class="card" style="margin-top: 18px;">
      <label class="field">
        <span>Filter</span>
        <input
          placeholder="Search by name, description, or tag..."
          .value=${props.filter}
          @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
        />
      </label>
    </section>

    <section class="card" style="margin-top: 18px;">
      ${props.loading
        ? html`<div class="muted">Loading presets...</div>`
        : filtered.length === 0
          ? html`
              <div class="muted">
                ${props.presets.length === 0
                  ? "No presets loaded. Place YAML files in the presets directory and click Reload from Disk."
                  : "No presets match the current filter."}
              </div>
            `
          : html`
              <div class="list">
                ${filtered.map((preset) => renderPresetCard(preset, props))}
              </div>
            `}
    </section>
  `;
}
