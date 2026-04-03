import { html, nothing } from "lit";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type {
  BudgetSnapshot,
  ChannelHealthEntry,
  CronSummary,
  MetricsDashboardData,
  RecentLogError,
  SystemHealthSnapshot,
  UsageSummarySnapshot,
} from "../controllers/metrics.ts";

// ============================================================================
// Props
// ============================================================================

export type MetricsDashboardProps = {
  connected: boolean;
  loading: boolean;
  data: MetricsDashboardData;
  onRefresh: () => void;
};

// ============================================================================
// Main render
// ============================================================================

export function renderMetricsDashboard(props: MetricsDashboardProps) {
  if (!props.connected) {
    return html`
      <section class="card" style="text-align: center; padding: 48px 24px;">
        <div class="card-title" style="font-size: 1.25rem;">Metrics Dashboard</div>
        <div class="muted" style="margin-top: 12px;">
          Connect to the gateway to view system metrics.
        </div>
      </section>
    `;
  }

  const { data } = props;

  return html`
    <style>${metricsStyles}</style>

    <!-- Header -->
    <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 18px;">
      <div>
        <div class="card-title" style="font-size: 1.25rem; margin: 0;">Metrics Dashboard</div>
        <div class="muted">System health, budget, channel status, and usage at a glance</div>
      </div>
      <button
        class="btn"
        ?disabled=${props.loading}
        @click=${() => props.onRefresh()}
      >
        ${props.loading ? "Refreshing..." : "Refresh"}
      </button>
    </div>

    <!-- Section 1: System Health -->
    ${renderSystemHealth(data.systemHealth)}

    <!-- Section 2: Token Budget -->
    ${renderBudget(data.budget)}

    <!-- Section 3: Usage Summary -->
    ${renderUsageSummary(data.usageSummary)}

    <!-- Section 4: Channel Status Grid -->
    ${renderChannelGrid(data.channels)}

    <!-- Section 5: Cron Summary -->
    ${renderCronSummary(data.cronSummary)}

    <!-- Section 6: Recent Errors -->
    ${renderRecentErrors(data.recentErrors)}
  `;
}

// ============================================================================
// Section 1: System Health
// ============================================================================

function renderSystemHealth(health: SystemHealthSnapshot) {
  const uptimeText = health.uptimeMs
    ? formatDurationHuman(health.uptimeMs)
    : "--";
  const tickText = health.tickIntervalMs
    ? `${health.tickIntervalMs}ms`
    : "--";
  const authText = health.authMode ?? "--";
  const versionText = health.gatewayVersion ?? "--";

  return html`
    <section class="metrics-health-grid" style="margin-bottom: 18px;">
      <div class="card stat-card">
        <div class="stat-label">Status</div>
        <div class="stat-value ${health.connected ? "ok" : "danger"}">
          ${health.connected ? "Connected" : "Offline"}
        </div>
        <div class="muted">Gateway connection</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value">${uptimeText}</div>
        <div class="muted">Since last restart</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${health.instanceCount}</div>
        <div class="muted">Active presence entries</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${health.sessionCount ?? "--"}</div>
        <div class="muted">Tracked sessions</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Tick Interval</div>
        <div class="stat-value" style="font-family: var(--mono); font-size: 0.95rem;">${tickText}</div>
        <div class="muted">Heartbeat frequency</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Auth Mode</div>
        <div class="stat-value" style="font-family: var(--mono); font-size: 0.95rem;">${authText}</div>
        <div class="muted">Authentication method</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Version</div>
        <div class="stat-value" style="font-family: var(--mono); font-size: 0.95rem;">${versionText}</div>
        <div class="muted">Gateway version</div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 2: Token Budget
// ============================================================================

function renderBudget(budget: BudgetSnapshot | null) {
  if (!budget) {
    return html`
      <section class="card" style="margin-bottom: 18px;">
        <div class="card-title">Token Budget</div>
        <div class="card-sub">Budget tracking from the intelligence pipeline</div>
        <div class="muted" style="margin-top: 16px; text-align: center; padding: 24px 0;">
          No budget data available. Intelligence pipeline may be disabled.
        </div>
      </section>
    `;
  }

  const dailyCostPct = budget.dailyCostCap > 0
    ? Math.min(100, (budget.dailyCost / budget.dailyCostCap) * 100)
    : 0;
  const sessionCostPct = budget.sessionCostCap > 0
    ? Math.min(100, (budget.sessionCost / budget.sessionCostCap) * 100)
    : 0;

  const dailyColor = barColor(dailyCostPct);
  const sessionColor = barColor(sessionCostPct);

  const tierKeys = Object.keys(budget.byTier);
  const maxTierTokens = tierKeys.reduce(
    (max, key) => Math.max(max, budget.byTier[key].tokens),
    1,
  );

  return html`
    <section class="grid grid-cols-2" style="margin-bottom: 18px;">
      <div class="card">
        <div class="card-title">Token Budget</div>
        <div class="card-sub">Daily and session cost tracking</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 16px;">
          <!-- Daily Cost -->
          <div>
            <div class="row" style="justify-content: space-between; margin-bottom: 6px;">
              <span class="muted">Daily Cost</span>
              <span class="${dailyColor}" style="font-family: var(--mono); font-size: 0.85rem;">
                $${budget.dailyCost.toFixed(2)} / $${budget.dailyCostCap.toFixed(2)}
              </span>
            </div>
            ${renderProgressBar(dailyCostPct, dailyColor)}
          </div>
          <!-- Session Cost -->
          <div>
            <div class="row" style="justify-content: space-between; margin-bottom: 6px;">
              <span class="muted">Session Cost</span>
              <span class="${sessionColor}" style="font-family: var(--mono); font-size: 0.85rem;">
                $${budget.sessionCost.toFixed(2)} / $${budget.sessionCostCap.toFixed(2)}
              </span>
            </div>
            ${renderProgressBar(sessionCostPct, sessionColor)}
          </div>
          <!-- Daily Tokens -->
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Daily Tokens</span>
            <span style="font-family: var(--mono); font-size: 0.85rem;">
              ${budget.dailyTokens.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Budget by Tier</div>
        <div class="card-sub">Token and cost consumption per model tier</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
          ${tierKeys.length === 0
            ? html`<div class="muted" style="text-align: center; padding: 24px 0;">No tier data.</div>`
            : tierKeys.map((tier) => {
                const data = budget.byTier[tier];
                const widthPct = Math.max(2, (data.tokens / maxTierTokens) * 100);
                return html`
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span class="metrics-tier-label">${tier}</span>
                    <div class="metrics-bar-track">
                      <div
                        class="metrics-bar-fill"
                        style="width: ${widthPct}%;"
                      ></div>
                    </div>
                    <span class="metrics-tier-value">${data.tokens.toLocaleString()}</span>
                    <span class="metrics-tier-cost">$${data.cost.toFixed(2)}</span>
                  </div>
                `;
              })
          }
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 3: Usage Summary
// ============================================================================

function renderUsageSummary(usage: UsageSummarySnapshot | null) {
  if (!usage) {
    return html`
      <section class="card" style="margin-bottom: 18px;">
        <div class="card-title">Usage Summary</div>
        <div class="card-sub">Token usage and cost from loaded sessions</div>
        <div class="muted" style="margin-top: 16px; text-align: center; padding: 24px 0;">
          No usage data loaded. Open the Usage tab and load a date range first.
        </div>
      </section>
    `;
  }

  const costText = usage.totalCost > 0 ? `$${usage.totalCost.toFixed(2)}` : "$0.00";
  const tokensText = formatTokenCount(usage.totalTokens);
  const latencyAvg = usage.latency ? `${Math.round(usage.latency.avgMs)}ms` : "--";
  const latencyP95 = usage.latency ? `${Math.round(usage.latency.p95Ms)}ms` : "--";

  // Build mini daily chart from costDaily (last 14 days max)
  const dailySlice = usage.costDaily.slice(-14);
  const maxDailyTokens = Math.max(1, ...dailySlice.map((d) => d.totalTokens));

  return html`
    <section style="margin-bottom: 18px;">
      <!-- Stat cards row -->
      <div class="metrics-usage-stat-row">
        <div class="card stat-card">
          <div class="stat-label">Total Tokens</div>
          <div class="stat-value">${tokensText}</div>
          <div class="muted">${usage.sessionCount} sessions</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Total Cost</div>
          <div class="stat-value">${costText}</div>
          <div class="muted">Across loaded range</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Messages</div>
          <div class="stat-value">${usage.messageCount.toLocaleString()}</div>
          <div class="muted">${usage.toolCallCount.toLocaleString()} tool calls</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Errors</div>
          <div class="stat-value ${usage.errorCount > 0 ? "danger" : "ok"}">
            ${usage.errorCount}
          </div>
          <div class="muted">In loaded sessions</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Avg Latency</div>
          <div class="stat-value" style="font-family: var(--mono);">${latencyAvg}</div>
          <div class="muted">p95: ${latencyP95}</div>
        </div>
      </div>

      <!-- Two-column: daily chart + top models/channels -->
      <div class="grid grid-cols-2" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Daily Tokens</div>
          <div class="card-sub">Last ${dailySlice.length} days</div>
          ${dailySlice.length === 0
            ? html`<div class="muted" style="margin-top: 16px; text-align: center;">No daily data.</div>`
            : html`
              <div class="metrics-daily-chart" style="margin-top: 16px;">
                ${dailySlice.map((day) => {
                  const heightPct = Math.max(2, (day.totalTokens / maxDailyTokens) * 100);
                  const dateLabel = day.date.slice(5); // MM-DD
                  return html`
                    <div class="metrics-daily-bar-wrapper" title="${day.date}: ${day.totalTokens.toLocaleString()} tokens, $${day.totalCost.toFixed(2)}">
                      <div class="metrics-daily-bar" style="height: ${heightPct}%;"></div>
                      <div class="metrics-daily-label">${dateLabel}</div>
                    </div>
                  `;
                })}
              </div>
            `
          }
        </div>
        <div class="card">
          <div class="card-title">Top Models</div>
          <div class="card-sub">By token consumption</div>
          <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px;">
            ${usage.topModels.length === 0
              ? html`<div class="muted" style="text-align: center;">No model data.</div>`
              : usage.topModels.map((m) => {
                  const maxModelTokens = Math.max(1, usage.topModels[0]?.tokens ?? 1);
                  const widthPct = Math.max(2, (m.tokens / maxModelTokens) * 100);
                  return html`
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span class="metrics-model-label" title="${m.provider}/${m.model}">${m.model}</span>
                      <div class="metrics-bar-track" style="flex: 1;">
                        <div class="metrics-bar-fill metrics-bar-fill--model" style="width: ${widthPct}%;"></div>
                      </div>
                      <span class="metrics-tier-value">${formatTokenCount(m.tokens)}</span>
                    </div>
                  `;
                })
            }
          </div>
          ${usage.topChannels.length > 0
            ? html`
              <div class="card-title" style="margin-top: 20px;">Top Channels</div>
              <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px;">
                ${usage.topChannels.map((c) => html`
                  <div class="row" style="justify-content: space-between;">
                    <span style="font-family: var(--mono); font-size: 0.85rem;">${c.channel}</span>
                    <span class="muted" style="font-family: var(--mono); font-size: 0.85rem;">
                      ${formatTokenCount(c.tokens)} / $${c.cost.toFixed(2)}
                    </span>
                  </div>
                `)}
              </div>
            `
            : nothing
          }
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 4: Channel Status Grid
// ============================================================================

function renderChannelGrid(channels: ChannelHealthEntry[]) {
  if (channels.length === 0) {
    return html`
      <section class="card" style="margin-bottom: 18px;">
        <div class="card-title">Channel Status</div>
        <div class="card-sub">Status of all messaging channels</div>
        <div class="muted" style="margin-top: 16px; text-align: center; padding: 24px 0;">
          No channel data. Connect to the gateway and refresh channels.
        </div>
      </section>
    `;
  }

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Channel Status</div>
      <div class="card-sub">${channels.length} channels configured</div>
      <div class="metrics-channel-grid" style="margin-top: 16px;">
        ${channels.map((ch) => renderChannelCard(ch))}
      </div>
    </section>
  `;
}

function renderChannelCard(channel: ChannelHealthEntry) {
  const statusClass = deriveChannelStatusClass(channel);
  const statusLabel = deriveChannelStatusLabel(channel);
  const lastActivity = channel.lastInboundAt
    ? formatRelativeTimestamp(channel.lastInboundAt)
    : null;
  const lastProbe = channel.lastProbeAt
    ? formatRelativeTimestamp(channel.lastProbeAt)
    : null;

  return html`
    <div class="metrics-channel-card">
      <div class="metrics-channel-header">
        <span class="metrics-channel-dot ${statusClass}"></span>
        <span class="metrics-channel-name">${channel.label}</span>
        ${channel.accountCount > 1
          ? html`<span class="muted" style="font-size: 0.75rem;">(${channel.accountCount} accounts)</span>`
          : nothing
        }
      </div>
      <div class="metrics-channel-status">
        <span class="${statusClass}" style="font-family: var(--mono); font-size: 0.8rem;">
          ${statusLabel}
        </span>
      </div>
      <div class="metrics-channel-meta">
        ${lastActivity
          ? html`<div class="muted" style="font-size: 0.75rem;">Last msg: ${lastActivity}</div>`
          : nothing
        }
        ${lastProbe
          ? html`<div class="muted" style="font-size: 0.75rem;">Probed: ${lastProbe}</div>`
          : nothing
        }
      </div>
      ${channel.lastError
        ? html`<div class="metrics-channel-error">${truncate(channel.lastError, 80)}</div>`
        : nothing
      }
    </div>
  `;
}

function deriveChannelStatusClass(ch: ChannelHealthEntry): string {
  if (!ch.configured) return "muted";
  if (ch.connected === true) return "ok";
  if (ch.running && ch.connected === null) return "warn";
  if (ch.running) return "ok";
  if (ch.lastError) return "danger";
  return "muted";
}

function deriveChannelStatusLabel(ch: ChannelHealthEntry): string {
  if (!ch.configured) return "Not configured";
  if (ch.connected === true) return "Connected";
  if (ch.running && ch.connected === null) return "Running";
  if (ch.running && ch.connected === false) return "Disconnected";
  if (ch.lastError) return "Error";
  return "Stopped";
}

// ============================================================================
// Section 5: Cron Summary
// ============================================================================

function renderCronSummary(cron: CronSummary | null) {
  if (!cron) {
    return nothing;
  }

  const nextWake = cron.nextWakeAtMs
    ? formatRelativeTimestamp(cron.nextWakeAtMs)
    : "--";

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Cron Jobs</div>
      <div class="card-sub">Scheduled task status</div>
      <div class="metrics-cron-row" style="margin-top: 16px;">
        <div class="stat">
          <div class="stat-label">Scheduler</div>
          <div class="stat-value ${cron.enabled ? "ok" : "warn"}">
            ${cron.enabled ? "Enabled" : "Disabled"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Jobs</div>
          <div class="stat-value">${cron.totalJobs}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Active Jobs</div>
          <div class="stat-value">${cron.enabledJobs}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Next Wake</div>
          <div class="stat-value" style="font-size: 0.85rem;">${nextWake}</div>
        </div>
      </div>
      ${cron.recentErrors.length > 0
        ? html`
          <div style="margin-top: 14px;">
            <div class="card-sub" style="margin-bottom: 8px;">Recent cron errors</div>
            ${cron.recentErrors.map((err) => html`
              <div class="callout danger" style="margin-bottom: 6px; font-size: 0.85rem;">
                <strong>${err.jobName}</strong>: ${truncate(err.error, 120)}
                ${err.lastRunAtMs
                  ? html`<span class="muted" style="margin-left: 8px;">${formatRelativeTimestamp(err.lastRunAtMs)}</span>`
                  : nothing
                }
              </div>
            `)}
          </div>
        `
        : nothing
      }
    </section>
  `;
}

// ============================================================================
// Section 6: Recent Errors
// ============================================================================

function renderRecentErrors(errors: RecentLogError[]) {
  if (errors.length === 0) {
    return html`
      <section class="card" style="margin-bottom: 18px;">
        <div class="card-title">Recent Errors</div>
        <div class="card-sub">Error-level log entries from the gateway</div>
        <div class="muted" style="margin-top: 16px; text-align: center; padding: 24px 0;">
          No recent errors found in loaded logs.
        </div>
      </section>
    `;
  }

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Recent Errors</div>
      <div class="card-sub">Last ${errors.length} error-level log entries</div>
      <div style="margin-top: 16px; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500; width: 140px;">Time</th>
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500; width: 120px;">Subsystem</th>
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500;">Message</th>
            </tr>
          </thead>
          <tbody>
            ${errors.map((err) => html`
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 6px 8px; font-family: var(--mono); color: var(--muted); white-space: nowrap;">
                  ${err.time ?? "--"}
                </td>
                <td style="padding: 6px 8px; font-family: var(--mono); color: var(--text);">
                  ${err.subsystem ?? "--"}
                </td>
                <td style="padding: 6px 8px; color: var(--danger);">
                  ${truncate(err.message ?? "--", 200)}
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ============================================================================
// Helpers
// ============================================================================

function renderProgressBar(pct: number, colorClass: string) {
  const cssColor =
    colorClass === "ok" ? "var(--ok)"
    : colorClass === "warn" ? "var(--warn)"
    : colorClass === "danger" ? "var(--danger)"
    : "var(--accent)";

  return html`
    <div style="height: 8px; background: var(--border); border-radius: 4px; overflow: hidden;">
      <div style="
        width: ${pct}%;
        height: 100%;
        background: ${cssColor};
        border-radius: 4px;
        transition: width 0.3s ease;
      "></div>
    </div>
  `;
}

function barColor(pct: number): string {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "ok";
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}\u2026`;
}

// ============================================================================
// Styles (scoped)
// ============================================================================

const metricsStyles = `
  .metrics-health-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
  }

  .metrics-usage-stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
  }

  .metrics-channel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }

  .metrics-channel-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .metrics-channel-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .metrics-channel-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .metrics-channel-dot.ok { background: var(--ok); }
  .metrics-channel-dot.warn { background: var(--warn); }
  .metrics-channel-dot.danger { background: var(--danger); }
  .metrics-channel-dot.muted { background: var(--muted); }

  .metrics-channel-name {
    font-weight: 500;
    font-size: 0.9rem;
    color: var(--text-strong);
  }

  .metrics-channel-status {
    /* status text inherits color from class */
  }

  .metrics-channel-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .metrics-channel-error {
    font-size: 0.75rem;
    color: var(--danger);
    margin-top: 4px;
    word-break: break-word;
  }

  .metrics-cron-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
  }

  .metrics-daily-chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 100px;
    padding-bottom: 20px;
    position: relative;
  }

  .metrics-daily-bar-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    justify-content: flex-end;
    position: relative;
    min-width: 0;
  }

  .metrics-daily-bar {
    width: 100%;
    max-width: 24px;
    background: var(--accent);
    border-radius: 3px 3px 0 0;
    transition: height 0.3s ease;
    min-height: 2px;
  }

  .metrics-daily-label {
    position: absolute;
    bottom: -18px;
    font-size: 0.65rem;
    color: var(--muted);
    font-family: var(--mono);
    white-space: nowrap;
  }

  .metrics-bar-track {
    height: 20px;
    background: var(--border);
    border-radius: 4px;
    overflow: hidden;
    flex: 1;
  }

  .metrics-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .metrics-bar-fill--model {
    background: var(--accent-2, var(--accent));
  }

  .metrics-tier-label {
    width: 70px;
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 0.85rem;
    color: var(--text);
  }

  .metrics-tier-value {
    width: 70px;
    flex-shrink: 0;
    text-align: right;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--text);
  }

  .metrics-tier-cost {
    width: 55px;
    flex-shrink: 0;
    text-align: right;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--muted);
  }

  .metrics-model-label {
    width: 110px;
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
