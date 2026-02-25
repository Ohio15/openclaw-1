import { html, nothing, type TemplateResult } from "lit";
import type { SecurityAuditFinding, SecurityAuditReport, SecurityAuditSeverity } from "./security.types.ts";
import { severityBadge } from "./security-shared.ts";

export type SecurityAuditProps = {
  report: SecurityAuditReport | null;
  loading: boolean;
  filterSeverity: string;
  onFilterChange: (severity: string) => void;
};

const SEVERITY_ORDER: Record<SecurityAuditSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

function renderFinding(finding: SecurityAuditFinding): TemplateResult {
  return html`
    <div
      class="finding"
      style="padding:12px 16px;border:1px solid var(--border, rgba(255,255,255,0.08));border-radius:8px;margin-bottom:8px;"
    >
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        ${severityBadge(finding.severity)}
        <code style="font-size:0.7rem;opacity:0.5;">${finding.checkId}</code>
      </div>
      <div style="font-weight:600;font-size:0.9rem;margin-bottom:4px;">${finding.title}</div>
      <div style="font-size:0.8rem;opacity:0.8;line-height:1.4;">${finding.detail}</div>
      ${finding.remediation
        ? html`<div
            style="margin-top:8px;padding:8px 12px;background:var(--surface-2, rgba(255,255,255,0.04));border-radius:6px;font-size:0.8rem;border-left:3px solid var(--primary, #6366f1);"
          >
            <strong>Remediation:</strong> ${finding.remediation}
          </div>`
        : nothing}
    </div>
  `;
}

export function renderSecurityAudit(props: SecurityAuditProps): TemplateResult {
  const findings = props.report?.findings ?? [];
  const summary = props.report?.summary;

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const filtered =
    props.filterSeverity === "all"
      ? sorted
      : sorted.filter((f) => f.severity === props.filterSeverity);

  return html`
    <section class="card" style="margin-bottom:24px;">
      <h3 style="margin:0 0 12px;font-size:1rem;font-weight:600;">Audit Findings</h3>

      ${!props.report && !props.loading
        ? html`<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.85rem;">
            No audit results yet. Run an audit from the posture panel above.
          </div>`
        : nothing}
      ${props.loading
        ? html`<div style="padding:24px;text-align:center;opacity:0.6;font-size:0.85rem;">
            Running security audit…
          </div>`
        : nothing}
      ${props.report && !props.loading
        ? html`
            <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
              <button
                class="chip ${props.filterSeverity === "all" ? "chip--active" : ""}"
                style="padding:4px 10px;border-radius:12px;border:1px solid var(--border, rgba(255,255,255,0.08));background:${props.filterSeverity === "all" ? "var(--primary, #6366f1)" : "transparent"};color:${props.filterSeverity === "all" ? "white" : "inherit"};cursor:pointer;font-size:0.75rem;"
                @click=${() => props.onFilterChange("all")}
              >
                All (${findings.length})
              </button>
              <button
                class="chip ${props.filterSeverity === "critical" ? "chip--active" : ""}"
                style="padding:4px 10px;border-radius:12px;border:1px solid var(--border, rgba(255,255,255,0.08));background:${props.filterSeverity === "critical" ? "var(--danger)" : "transparent"};color:${props.filterSeverity === "critical" ? "white" : "inherit"};cursor:pointer;font-size:0.75rem;"
                @click=${() => props.onFilterChange("critical")}
              >
                Critical (${summary?.critical ?? 0})
              </button>
              <button
                class="chip ${props.filterSeverity === "warn" ? "chip--active" : ""}"
                style="padding:4px 10px;border-radius:12px;border:1px solid var(--border, rgba(255,255,255,0.08));background:${props.filterSeverity === "warn" ? "var(--warning)" : "transparent"};color:${props.filterSeverity === "warn" ? "white" : "inherit"};cursor:pointer;font-size:0.75rem;"
                @click=${() => props.onFilterChange("warn")}
              >
                Warn (${summary?.warn ?? 0})
              </button>
              <button
                class="chip ${props.filterSeverity === "info" ? "chip--active" : ""}"
                style="padding:4px 10px;border-radius:12px;border:1px solid var(--border, rgba(255,255,255,0.08));background:${props.filterSeverity === "info" ? "var(--info, #3b82f6)" : "transparent"};color:${props.filterSeverity === "info" ? "white" : "inherit"};cursor:pointer;font-size:0.75rem;"
                @click=${() => props.onFilterChange("info")}
              >
                Info (${summary?.info ?? 0})
              </button>
            </div>
            <div style="max-height:500px;overflow-y:auto;scrollbar-width:thin;">
              ${filtered.length === 0
                ? html`<div style="padding:16px;text-align:center;opacity:0.4;font-size:0.85rem;">
                    No findings match the selected filter.
                  </div>`
                : filtered.map(renderFinding)}
            </div>
          `
        : nothing}
    </section>
  `;
}
