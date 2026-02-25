import type { SecurityActivityEntry, SecurityAuditSeverity } from "../views/security.types.ts";

const MAX_ACTIVITY_ENTRIES = 200;

let activitySeq = 0;

export type SecurityActivityState = {
  securityActivityEntries: SecurityActivityEntry[];
};

export function addSecurityActivityEntry(
  state: SecurityActivityState,
  entry: Omit<SecurityActivityEntry, "id">,
): void {
  activitySeq += 1;
  const full: SecurityActivityEntry = {
    ...entry,
    id: `sa-${activitySeq}-${Date.now()}`,
  };
  state.securityActivityEntries = [full, ...state.securityActivityEntries].slice(
    0,
    MAX_ACTIVITY_ENTRIES,
  );
}

export function parseToolEventToActivity(
  payload: Record<string, unknown> | undefined,
): Omit<SecurityActivityEntry, "id"> | null {
  if (!payload) return null;
  const toolName =
    typeof payload.tool === "string"
      ? payload.tool
      : typeof payload.name === "string"
        ? payload.name
        : null;
  if (!toolName) return null;

  const status = typeof payload.status === "string" ? payload.status : "invoked";
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  const severity: SecurityAuditSeverity =
    toolName === "exec" || toolName === "shell" ? "warn" : "info";

  return {
    ts: Date.now(),
    severity,
    category: "tools",
    summary: `Tool ${toolName} ${status}`,
    detail: sessionKey ? `Session: ${sessionKey}` : undefined,
  };
}

export function parseExecApprovalToActivity(
  payload: Record<string, unknown> | undefined,
  eventType: "requested" | "resolved",
): Omit<SecurityActivityEntry, "id"> | null {
  if (!payload) return null;
  const command = typeof payload.command === "string" ? payload.command : "unknown";
  const decision = typeof payload.decision === "string" ? payload.decision : undefined;
  const severity: SecurityAuditSeverity = eventType === "requested" ? "warn" : "info";

  return {
    ts: Date.now(),
    severity,
    category: "exec",
    summary:
      eventType === "requested"
        ? `Exec approval requested: ${command}`
        : `Exec approval ${decision ?? "resolved"}: ${command}`,
    detail:
      typeof payload.agentId === "string" ? `Agent: ${payload.agentId}` : undefined,
  };
}
