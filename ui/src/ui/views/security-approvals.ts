import { html, type TemplateResult } from "lit";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";

export type SecurityApprovalsProps = {
  queue: ExecApprovalRequest[];
  busy: boolean;
  onDecision: (decision: "allow-once" | "allow-always" | "deny") => void;
};

function formatExpiry(expiresAtMs: number): string {
  const remaining = Math.max(0, expiresAtMs - Date.now());
  const secs = Math.ceil(remaining / 1000);
  return secs > 0 ? `${secs}s` : "expired";
}

function renderApprovalRow(
  entry: ExecApprovalRequest,
  props: SecurityApprovalsProps,
): TemplateResult {
  return html`
    <tr
      style="border-bottom:1px solid var(--border, rgba(255,255,255,0.06));"
    >
      <td style="padding:8px 12px;font-family:monospace;font-size:0.8rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${entry.command}>
        ${entry.command}
      </td>
      <td style="padding:8px 12px;font-size:0.8rem;">${entry.agentId ?? "—"}</td>
      <td style="padding:8px 12px;font-size:0.8rem;">${entry.sessionKey ?? "—"}</td>
      <td style="padding:8px 12px;font-size:0.8rem;">${entry.hostname ?? "—"}</td>
      <td style="padding:8px 12px;font-size:0.8rem;font-family:monospace;">
        ${formatExpiry(entry.expiresAtMs)}
      </td>
      <td style="padding:8px 8px;white-space:nowrap;">
        <button
          class="btn btn--xs btn--success"
          style="margin-right:4px;padding:3px 8px;font-size:0.7rem;border-radius:4px;background:var(--success, #22c55e);color:white;border:none;cursor:pointer;"
          ?disabled=${props.busy}
          @click=${() => props.onDecision("allow-once")}
        >
          Allow Once
        </button>
        <button
          class="btn btn--xs btn--primary"
          style="margin-right:4px;padding:3px 8px;font-size:0.7rem;border-radius:4px;background:var(--primary, #6366f1);color:white;border:none;cursor:pointer;"
          ?disabled=${props.busy}
          @click=${() => props.onDecision("allow-always")}
        >
          Always Allow
        </button>
        <button
          class="btn btn--xs btn--danger"
          style="padding:3px 8px;font-size:0.7rem;border-radius:4px;background:var(--danger);color:white;border:none;cursor:pointer;"
          ?disabled=${props.busy}
          @click=${() => props.onDecision("deny")}
        >
          Deny
        </button>
      </td>
    </tr>
  `;
}

export function renderSecurityApprovals(props: SecurityApprovalsProps): TemplateResult {
  return html`
    <section class="card" style="margin-bottom:24px;">
      <h3 style="margin:0 0 12px;font-size:1rem;font-weight:600;">
        Approval Queue
        ${props.queue.length > 0
          ? html`<span
              style="background:var(--danger);color:white;padding:2px 7px;border-radius:10px;font-size:0.7rem;margin-left:8px;vertical-align:middle;"
              >${props.queue.length}</span
            >`
          : ""}
      </h3>
      ${props.queue.length === 0
        ? html`<div style="padding:24px;text-align:center;opacity:0.4;font-size:0.85rem;">
            No pending approvals.
          </div>`
        : html`
            <div style="overflow-x:auto;">
              <table
                style="width:100%;border-collapse:collapse;font-size:0.85rem;"
              >
                <thead>
                  <tr style="border-bottom:2px solid var(--border, rgba(255,255,255,0.08));text-align:left;">
                    <th style="padding:8px 12px;font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;">Command</th>
                    <th style="padding:8px 12px;font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;">Agent</th>
                    <th style="padding:8px 12px;font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;">Session</th>
                    <th style="padding:8px 12px;font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;">Host</th>
                    <th style="padding:8px 12px;font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;">Expires</th>
                    <th style="padding:8px 8px;font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${props.queue.map((entry) => renderApprovalRow(entry, props))}
                </tbody>
              </table>
            </div>
          `}
    </section>
  `;
}
