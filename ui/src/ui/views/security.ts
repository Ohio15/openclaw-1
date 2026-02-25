import { html, type TemplateResult } from "lit";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import type { SecurityAuditReport, SecurityActivityEntry } from "./security.types.ts";
import { renderSecurityPosture } from "./security-posture.ts";
import { renderSecurityToggles } from "./security-toggles.ts";
import { renderSecurityActivity } from "./security-activity.ts";
import { renderSecurityAudit } from "./security-audit.ts";
import { renderSecurityApprovals } from "./security-approvals.ts";

export type SecurityProps = {
  // Posture
  report: SecurityAuditReport | null;
  auditLoading: boolean;
  configForm: Record<string, unknown> | null;
  sessionsCount: number | null;
  onRunAudit: () => void;
  onRunDeepAudit: () => void;

  // Toggles
  configDirty: boolean;
  configSaving: boolean;
  expandedToggleGroups: Set<string>;
  onToggleGroup: (groupId: string) => void;
  onPatch: (path: (string | number)[], value: unknown) => void;
  onSave: () => void;
  onSaveAndApply: () => void;

  // Activity
  activityEntries: SecurityActivityEntry[];
  activityFilter: string;
  onActivityFilterChange: (category: string) => void;

  // Audit
  auditFilterSeverity: string;
  onAuditFilterChange: (severity: string) => void;

  // Approvals
  approvalQueue: ExecApprovalRequest[];
  approvalBusy: boolean;
  onApprovalDecision: (decision: "allow-once" | "allow-always" | "deny") => void;
};

export function renderSecurity(props: SecurityProps): TemplateResult {
  return html`
    <div class="security-view" style="max-width:900px;">
      ${renderSecurityPosture({
        report: props.report,
        loading: props.auditLoading,
        configForm: props.configForm,
        sessionsCount: props.sessionsCount,
        onRunAudit: props.onRunAudit,
        onRunDeepAudit: props.onRunDeepAudit,
      })}

      ${renderSecurityApprovals({
        queue: props.approvalQueue,
        busy: props.approvalBusy,
        onDecision: props.onApprovalDecision,
      })}

      ${renderSecurityToggles({
        configForm: props.configForm,
        configDirty: props.configDirty,
        configSaving: props.configSaving,
        expandedGroups: props.expandedToggleGroups,
        onToggleGroup: props.onToggleGroup,
        onPatch: props.onPatch,
        onSave: props.onSave,
        onSaveAndApply: props.onSaveAndApply,
      })}

      ${renderSecurityActivity({
        entries: props.activityEntries,
        filterCategory: props.activityFilter,
        onFilterChange: props.onActivityFilterChange,
      })}

      ${renderSecurityAudit({
        report: props.report,
        loading: props.auditLoading,
        filterSeverity: props.auditFilterSeverity,
        onFilterChange: props.onAuditFilterChange,
      })}
    </div>
  `;
}
