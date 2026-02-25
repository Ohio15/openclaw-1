import { html, nothing, type TemplateResult } from "lit";
import { SECURITY_TOGGLE_GROUPS, type ToggleGroup, type ToggleMeta } from "./security-toggles.data.ts";

export type SecurityTogglesProps = {
  configForm: Record<string, unknown> | null;
  configDirty: boolean;
  configSaving: boolean;
  expandedGroups: Set<string>;
  onToggleGroup: (groupId: string) => void;
  onPatch: (path: (string | number)[], value: unknown) => void;
  onSave: () => void;
  onSaveAndApply: () => void;
};

function resolveValue(obj: Record<string, unknown> | null, path: (string | number)[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[String(key)];
  }
  return current;
}

function renderToggle(toggle: ToggleMeta, props: SecurityTogglesProps): TemplateResult {
  const currentValue = resolveValue(props.configForm, toggle.configPath);

  if (toggle.type === "boolean") {
    const checked = currentValue === true;
    return html`
      <div
        class="toggle-row"
        style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border, rgba(255,255,255,0.06));"
      >
        <div style="flex:1;">
          <div style="font-weight:500;font-size:0.875rem;">${toggle.label}</div>
          <div style="font-size:0.75rem;opacity:0.6;">${toggle.description}</div>
          ${toggle.restartRequired
            ? html`<div style="font-size:0.7rem;color:var(--warning);margin-top:2px;">
                Requires restart
              </div>`
            : nothing}
        </div>
        <label
          class="switch"
          style="position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;"
        >
          <input
            type="checkbox"
            .checked=${checked}
            @change=${(e: Event) =>
              props.onPatch(toggle.configPath, (e.target as HTMLInputElement).checked)}
            style="opacity:0;width:0;height:0;"
          />
          <span
            class="slider"
            style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${checked ? "var(--success, #22c55e)" : "var(--surface-3, rgba(255,255,255,0.1))"};border-radius:11px;transition:background 0.2s;"
          >
            <span
              style="position:absolute;height:16px;width:16px;left:${checked ? "20px" : "3px"};bottom:3px;background:white;border-radius:50%;transition:left 0.2s;"
            ></span>
          </span>
        </label>
      </div>
    `;
  }

  if (toggle.type === "select" && toggle.options) {
    const strValue = String(currentValue ?? "");
    return html`
      <div
        class="toggle-row"
        style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border, rgba(255,255,255,0.06));"
      >
        <div style="flex:1;">
          <div style="font-weight:500;font-size:0.875rem;">${toggle.label}</div>
          <div style="font-size:0.75rem;opacity:0.6;">${toggle.description}</div>
          ${toggle.restartRequired
            ? html`<div style="font-size:0.7rem;color:var(--warning);margin-top:2px;">
                Requires restart
              </div>`
            : nothing}
        </div>
        <select
          style="background:var(--surface-2, rgba(255,255,255,0.04));color:inherit;border:1px solid var(--border, rgba(255,255,255,0.08));border-radius:6px;padding:4px 8px;font-size:0.8rem;"
          @change=${(e: Event) =>
            props.onPatch(toggle.configPath, (e.target as HTMLSelectElement).value)}
        >
          ${toggle.options.map(
            (opt) =>
              html`<option value=${opt.value} ?selected=${strValue === opt.value}>${opt.label}</option>`,
          )}
        </select>
      </div>
    `;
  }

  return html``;
}

function renderGroup(group: ToggleGroup, props: SecurityTogglesProps): TemplateResult {
  const expanded = props.expandedGroups.has(group.id);
  return html`
    <div
      class="accordion-group"
      style="border:1px solid var(--border, rgba(255,255,255,0.08));border-radius:8px;margin-bottom:8px;overflow:hidden;"
    >
      <button
        class="accordion-header"
        style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 16px;background:var(--surface-2, rgba(255,255,255,0.04));border:none;color:inherit;cursor:pointer;text-align:left;font-size:0.9rem;"
        @click=${() => props.onToggleGroup(group.id)}
      >
        <div>
          <div style="font-weight:600;">${group.label}</div>
          <div style="font-size:0.75rem;opacity:0.6;">${group.description}</div>
        </div>
        <span style="font-size:1.1rem;opacity:0.5;">${expanded ? "−" : "+"}</span>
      </button>
      ${expanded
        ? html`<div class="accordion-body" style="padding:8px 16px;">
            ${group.toggles.map((t) => renderToggle(t, props))}
          </div>`
        : nothing}
    </div>
  `;
}

export function renderSecurityToggles(props: SecurityTogglesProps): TemplateResult {
  return html`
    <section class="card" style="margin-bottom:24px;">
      <h3 style="margin:0 0 16px;font-size:1rem;font-weight:600;">Security Controls</h3>
      ${SECURITY_TOGGLE_GROUPS.map((g) => renderGroup(g, props))}
      ${props.configDirty
        ? html`<div
            class="sticky-footer"
            style="position:sticky;bottom:0;background:var(--surface-1, #1a1a2e);padding:12px 0;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border, rgba(255,255,255,0.08));margin-top:16px;"
          >
            <button
              class="btn btn--sm"
              ?disabled=${props.configSaving}
              @click=${props.onSave}
            >
              Save
            </button>
            <button
              class="btn btn--sm btn--primary"
              ?disabled=${props.configSaving}
              @click=${props.onSaveAndApply}
            >
              Save & Apply
            </button>
          </div>`
        : nothing}
    </section>
  `;
}
