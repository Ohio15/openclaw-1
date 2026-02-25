import type { GatewayBrowserClient } from "../gateway.ts";
import type { SecurityAuditReport } from "../views/security.types.ts";
import { updateConfigFormValue } from "./config.ts";

export type SecurityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  securityAuditReport: SecurityAuditReport | null;
  securityAuditLoading: boolean;
  securityAuditError: string | null;
  configForm: Record<string, unknown> | null;
  configFormDirty: boolean;
  configSaving: boolean;
};

export async function loadSecurityAudit(
  state: SecurityState,
  opts?: { quiet?: boolean; deep?: boolean },
): Promise<void> {
  if (!state.client || !state.connected) return;
  if (state.securityAuditLoading && !opts?.quiet) return;

  if (!opts?.quiet) {
    state.securityAuditLoading = true;
    state.securityAuditError = null;
  }
  try {
    const report = await state.client.request<SecurityAuditReport>("security.audit", {
      deep: opts?.deep ?? false,
    });
    state.securityAuditReport = report;
  } catch (err) {
    state.securityAuditError = String(err);
  } finally {
    state.securityAuditLoading = false;
  }
}

export function patchSecurityToggle(
  state: SecurityState,
  path: (string | number)[],
  value: unknown,
): void {
  updateConfigFormValue(state as Parameters<typeof updateConfigFormValue>[0], path, value);
}
