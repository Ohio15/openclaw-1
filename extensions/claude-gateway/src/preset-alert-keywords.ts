/**
 * Alert keyword scanning for preset agent runs.
 *
 * Hooks into agent_end to detect WARNING/CRITICAL/FAIL/ERROR in output.
 * Port of ClaudeGateway app/services/scheduler.py:119-126
 */

const DEFAULT_ALERT_KEYWORDS = ["WARNING", "CRITICAL", "FAIL", "ERROR"];

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertEntry = {
  timestamp: string;
  preset: string;
  severity: AlertSeverity;
  message: string;
};

export function detectAlertKeywords(
  text: string,
  keywords: string[] = DEFAULT_ALERT_KEYWORDS,
): { detected: boolean; severity: AlertSeverity } {
  const upper = text.toUpperCase();
  const matched = keywords.filter((kw) => upper.includes(kw.toUpperCase()));

  if (matched.length === 0) {
    return { detected: false, severity: "info" };
  }

  const severity: AlertSeverity = matched.some((kw) => kw.toUpperCase() === "CRITICAL")
    ? "critical"
    : "warning";

  return { detected: true, severity };
}

/**
 * Create an agent_end hook handler that scans for alert keywords.
 *
 * The handler checks if the completed session was a cron/preset run
 * by looking for the "preset:" prefix in the session metadata.
 * When alert keywords are detected, it logs the alert and optionally
 * calls a delivery callback.
 */
export function createAlertKeywordHandler(opts: {
  keywords?: string[];
  onAlert?: (alert: AlertEntry) => void | Promise<void>;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}) {
  const keywords = opts.keywords ?? DEFAULT_ALERT_KEYWORDS;
  const log = opts.logger ?? console;
  const alertHistory: AlertEntry[] = [];

  const handler = async (
    event: { messages?: unknown[]; success?: boolean; error?: string },
  ): Promise<void> => {
    // Extract the last assistant message text
    const messages = event.messages ?? [];
    const lastAssistant = [...messages]
      .reverse()
      .find((m: any) => m?.role === "assistant");
    if (!lastAssistant) return;

    const text =
      typeof (lastAssistant as any).content === "string"
        ? (lastAssistant as any).content
        : Array.isArray((lastAssistant as any).content)
          ? (lastAssistant as any).content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n")
          : "";

    if (!text) return;

    // Check for error status
    if (event.error || event.success === false) {
      const alert: AlertEntry = {
        timestamp: new Date().toISOString(),
        preset: "unknown",
        severity: "critical",
        message: event.error ?? text.slice(0, 500),
      };
      alertHistory.push(alert);
      if (alertHistory.length > 100) alertHistory.shift();
      log.warn(`[claude-gateway] Alert (critical): ${alert.message.slice(0, 200)}`);
      if (opts.onAlert) await opts.onAlert(alert);
      return;
    }

    // Check for keywords
    const { detected, severity } = detectAlertKeywords(text, keywords);
    if (detected) {
      const alert: AlertEntry = {
        timestamp: new Date().toISOString(),
        preset: "unknown",
        severity,
        message: text.slice(0, 500),
      };
      alertHistory.push(alert);
      if (alertHistory.length > 100) alertHistory.shift();
      log.warn(`[claude-gateway] Alert (${severity}): ${alert.message.slice(0, 200)}`);
      if (opts.onAlert) await opts.onAlert(alert);
    }
  };

  return { handler, alertHistory };
}
