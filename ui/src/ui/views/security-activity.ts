import { html, nothing, type TemplateResult } from "lit";
import type { SecurityActivityEntry } from "./security.types.ts";
import { severityBadge, formatTimestamp } from "./security-shared.ts";

export type SecurityActivityProps = {
  entries: SecurityActivityEntry[];
  filterCategory: string;
  onFilterChange: (category: string) => void;
};

const CATEGORIES = ["all", "tools", "exec", "sessions", "chat"] as const;

const CATEGORY_ICONS: Record<string, string> = {
  tools: "\u{1f527}",
  exec: "\u{1f4bb}",
  sessions: "\u{1f465}",
  chat: "\u{1f4ac}",
};

function renderEntry(entry: SecurityActivityEntry): TemplateResult {
  return html`
    <div
      class="activity-entry"
      style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border, rgba(255,255,255,0.04));"
    >
      <span style="font-size:0.7rem;opacity:0.5;white-space:nowrap;padding-top:2px;"
        >${formatTimestamp(entry.ts)}</span
      >
      ${severityBadge(entry.severity)}
      <span style="font-size:0.85rem;" title=${entry.category}
        >${CATEGORY_ICONS[entry.category] ?? ""}</span
      >
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.85rem;font-weight:500;">${entry.summary}</div>
        ${entry.detail
          ? html`<div style="font-size:0.75rem;opacity:0.6;margin-top:2px;">${entry.detail}</div>`
          : nothing}
      </div>
    </div>
  `;
}

export function renderSecurityActivity(props: SecurityActivityProps): TemplateResult {
  const filtered =
    props.filterCategory === "all"
      ? props.entries
      : props.entries.filter((e) => e.category === props.filterCategory);

  return html`
    <section class="card" style="margin-bottom:24px;">
      <h3 style="margin:0 0 12px;font-size:1rem;font-weight:600;">Activity Feed</h3>
      <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
        ${CATEGORIES.map(
          (cat) => html`
            <button
              class="chip ${props.filterCategory === cat ? "chip--active" : ""}"
              style="padding:4px 10px;border-radius:12px;border:1px solid var(--border, rgba(255,255,255,0.08));background:${props.filterCategory === cat ? "var(--primary, #6366f1)" : "transparent"};color:${props.filterCategory === cat ? "white" : "inherit"};cursor:pointer;font-size:0.75rem;text-transform:capitalize;"
              @click=${() => props.onFilterChange(cat)}
            >
              ${cat === "all"
                ? `All (${props.entries.length})`
                : `${cat} (${props.entries.filter((e) => e.category === cat).length})`}
            </button>
          `,
        )}
      </div>
      <div
        class="activity-list"
        style="max-height:320px;overflow-y:auto;scrollbar-width:thin;"
      >
        ${filtered.length === 0
          ? html`<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.85rem;">
              No activity recorded yet.
            </div>`
          : filtered.map(renderEntry)}
      </div>
    </section>
  `;
}
