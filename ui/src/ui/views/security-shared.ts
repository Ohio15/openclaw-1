import { html, type TemplateResult } from "lit";
import type { SecurityAuditSeverity } from "./security.types.ts";

const SEVERITY_COLORS: Record<SecurityAuditSeverity, string> = {
  critical: "var(--danger)",
  warn: "var(--warning)",
  info: "var(--info)",
};

const SEVERITY_BG: Record<SecurityAuditSeverity, string> = {
  critical: "var(--danger-bg, rgba(239,68,68,0.12))",
  warn: "var(--warning-bg, rgba(234,179,8,0.12))",
  info: "var(--info-bg, rgba(59,130,246,0.12))",
};

export function severityBadge(severity: SecurityAuditSeverity): TemplateResult {
  const color = SEVERITY_COLORS[severity];
  const bg = SEVERITY_BG[severity];
  return html`<span
    class="severity-badge"
    style="color:${color};background:${bg};padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;"
    >${severity}</span
  >`;
}

export function severityBanner(
  critical: number,
  warn: number,
): TemplateResult {
  if (critical > 0) {
    return html`<div
      class="callout callout--danger"
      style="background:var(--danger-bg, rgba(239,68,68,0.12));border-left:4px solid var(--danger);padding:12px 16px;border-radius:6px;margin-bottom:16px;display:flex;align-items:center;gap:8px;"
    >
      <span style="font-size:1.25rem;">&#x26a0;</span>
      <span
        ><strong>${critical} critical</strong> finding${critical > 1 ? "s" : ""} require
        attention${warn > 0
          ? html`, plus <strong>${warn}</strong> warning${warn > 1 ? "s" : ""}`
          : ""}</span
      >
    </div>`;
  }
  if (warn > 0) {
    return html`<div
      class="callout callout--warning"
      style="background:var(--warning-bg, rgba(234,179,8,0.12));border-left:4px solid var(--warning);padding:12px 16px;border-radius:6px;margin-bottom:16px;display:flex;align-items:center;gap:8px;"
    >
      <span style="font-size:1.25rem;">&#x26a0;</span>
      <span
        ><strong>${warn} warning${warn > 1 ? "s" : ""}</strong> — review recommended</span
      >
    </div>`;
  }
  return html`<div
    class="callout callout--ok"
    style="background:var(--success-bg, rgba(34,197,94,0.12));border-left:4px solid var(--success, #22c55e);padding:12px 16px;border-radius:6px;margin-bottom:16px;display:flex;align-items:center;gap:8px;"
  >
    <span style="font-size:1.25rem;">&#x2705;</span>
    <span><strong>All clear</strong> — no critical or warning findings</span>
  </div>`;
}

export function statChip(
  label: string,
  value: string,
  level: "safe" | "caution" | "risky",
): TemplateResult {
  const colorMap = {
    safe: "var(--success, #22c55e)",
    caution: "var(--warning)",
    risky: "var(--danger)",
  };
  const bgMap = {
    safe: "var(--success-bg, rgba(34,197,94,0.12))",
    caution: "var(--warning-bg, rgba(234,179,8,0.12))",
    risky: "var(--danger-bg, rgba(239,68,68,0.12))",
  };
  return html`<div
    class="stat-chip"
    style="display:flex;flex-direction:column;gap:4px;padding:12px 16px;border-radius:8px;background:var(--surface-2, rgba(255,255,255,0.04));border:1px solid var(--border, rgba(255,255,255,0.08));"
  >
    <span
      style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;"
      >${label}</span
    >
    <span
      style="font-weight:600;color:${colorMap[level]};background:${bgMap[level]};padding:2px 8px;border-radius:4px;font-size:0.85rem;width:fit-content;"
      >${value}</span
    >
  </div>`;
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
