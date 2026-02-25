import { html, nothing, type TemplateResult } from "lit";
import type { SecurityAuditReport } from "./security.types.ts";
import { severityBanner, statChip } from "./security-shared.ts";

export type SecurityPostureProps = {
  report: SecurityAuditReport | null;
  loading: boolean;
  configForm: Record<string, unknown> | null;
  sessionsCount: number | null;
  onRunAudit: () => void;
  onRunDeepAudit: () => void;
};

function resolve(obj: Record<string, unknown> | null, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function levelForValue(
  key: string,
  value: unknown,
): "safe" | "caution" | "risky" {
  const s = String(value ?? "").toLowerCase();
  switch (key) {
    case "sandbox":
      return s === "all" ? "safe" : s === "non-main" ? "caution" : "risky";
    case "exec":
      return s === "allowlist" ? "safe" : s === "off" ? "risky" : "caution";
    case "bind":
      return s === "loopback" ? "safe" : s === "lan" ? "caution" : "risky";
    case "auth":
      return s === "token" || s === "password" ? "safe" : s === "none" ? "risky" : "caution";
    case "elevated":
      return value === true ? "risky" : "safe";
    default:
      return "caution";
  }
}

export function renderSecurityPosture(props: SecurityPostureProps): TemplateResult {
  const cfg = props.configForm;
  const sandboxMode = String(resolve(cfg, ["agents", "defaults", "sandbox", "mode"]) ?? "off");
  const execPolicy = String(resolve(cfg, ["tools", "exec", "security"]) ?? "open");
  const gatewayBind = String(resolve(cfg, ["gateway", "bind"]) ?? "loopback");
  const authMode = String(resolve(cfg, ["gateway", "auth", "mode"]) ?? "none");
  const elevated = resolve(cfg, ["tools", "elevated", "enabled"]);
  const sessionsStr =
    props.sessionsCount != null ? String(props.sessionsCount) : "—";

  const summary = props.report?.summary;

  return html`
    <section class="card" style="margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:1rem;font-weight:600;">Security Posture</h3>
        <div style="display:flex;gap:8px;">
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRunAudit}>
            ${props.loading ? "Running…" : "Run Audit"}
          </button>
          <button class="btn btn--sm btn--ghost" ?disabled=${props.loading} @click=${props.onRunDeepAudit}>
            Deep Audit
          </button>
        </div>
      </div>

      ${summary ? severityBanner(summary.critical, summary.warn) : nothing}

      <div
        style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;"
      >
        ${statChip("Sandbox Mode", sandboxMode, levelForValue("sandbox", sandboxMode))}
        ${statChip("Exec Policy", execPolicy, levelForValue("exec", execPolicy))}
        ${statChip("Gateway Bind", gatewayBind, levelForValue("bind", gatewayBind))}
        ${statChip("Auth Mode", authMode, levelForValue("auth", authMode))}
        ${statChip("Active Sessions", sessionsStr, "caution")}
        ${statChip("Elevated Exec", elevated === true ? "Enabled" : "Disabled", levelForValue("elevated", elevated))}
      </div>
    </section>
  `;
}
