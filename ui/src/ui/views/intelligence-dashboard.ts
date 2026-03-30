import { html, nothing } from "lit";

// ============================================================================
// Types
// ============================================================================

export type IntelligenceStats = {
  config: {
    enabled: boolean;
    knowledgeSource: string;
    chainingEnabled: boolean;
    chainingThreshold: number;
    ragMaxIterations: number;
    ragRelevanceThreshold: number;
    sandboxEnabled: boolean;
  };
  feedback: {
    totalEntries: number;
    avgConfidence: number;
    coherenceRate: number;
    refusalRate: number;
    byCategory: Array<{
      category: string;
      count: number;
      avgConfidence: number;
      coherenceRate: number;
      refusalRate: number;
    }>;
    byTier: Record<string, { count: number; avgConfidence: number }>;
    byPipeline: Record<string, { count: number; avgConfidence: number }>;
    recentEntries: Array<{
      timestamp: number;
      category: string;
      tier: string;
      confidence: number;
      coherent: boolean;
      refusalDetected: boolean;
      chainedExecution?: boolean;
      complexity?: number;
    }>;
  };
  budget: {
    dailyTokens: number;
    dailyCost: number;
    dailyCostCap: number;
    sessionCost: number;
    sessionCostCap: number;
    byTier: Record<string, { tokens: number; cost: number; requests: number }>;
  } | null;
};

export type IntelligenceDashboardProps = {
  connected: boolean;
  loading: boolean;
  stats: IntelligenceStats | null;
  onRefresh: () => void;
};

// ============================================================================
// Helpers
// ============================================================================

function confidenceColor(value: number): string {
  if (value >= 0.8) return "ok";
  if (value >= 0.6) return "warn";
  return "danger";
}

function refusalColor(value: number): string {
  if (value <= 0.05) return "ok";
  if (value <= 0.15) return "warn";
  return "danger";
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function maxTierCount(byTier: Record<string, { count: number; avgConfidence: number }>): number {
  let max = 0;
  for (const key of Object.keys(byTier)) {
    if (byTier[key].count > max) max = byTier[key].count;
  }
  return max || 1;
}

// ============================================================================
// Render
// ============================================================================

export function renderIntelligenceDashboard(props: IntelligenceDashboardProps) {
  if (!props.connected) {
    return html`
      <section class="card" style="text-align: center; padding: 48px 24px;">
        <div class="card-title" style="font-size: 1.25rem;">Intelligence Dashboard</div>
        <div class="muted" style="margin-top: 12px;">
          Connect to the gateway to view intelligence pipeline metrics.
        </div>
      </section>
    `;
  }

  if (props.loading && !props.stats) {
    return html`
      <section class="card" style="text-align: center; padding: 48px 24px;">
        <div class="card-title" style="font-size: 1.25rem;">Intelligence Dashboard</div>
        <div class="muted" style="margin-top: 12px;">Loading pipeline data...</div>
      </section>
    `;
  }

  if (!props.stats) {
    return html`
      <section class="card" style="text-align: center; padding: 48px 24px;">
        <div class="card-title" style="font-size: 1.25rem;">Intelligence Dashboard</div>
        <div class="muted" style="margin-top: 12px;">
          No intelligence data available yet. The pipeline will collect metrics as requests are processed.
        </div>
        <button
          class="btn"
          style="margin-top: 16px;"
          @click=${() => props.onRefresh()}
        >
          Refresh
        </button>
      </section>
    `;
  }

  const { config, feedback, budget } = props.stats;

  return html`
    <!-- Header -->
    <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 18px;">
      <div>
        <div class="card-title" style="font-size: 1.25rem; margin: 0;">Intelligence Dashboard</div>
        <div class="muted">Pipeline metrics, quality scores, and feedback analysis</div>
      </div>
      <button
        class="btn"
        ?disabled=${props.loading}
        @click=${() => props.onRefresh()}
      >
        ${props.loading ? "Refreshing..." : "Refresh"}
      </button>
    </div>

    <!-- Section 1: Pipeline Status -->
    ${renderPipelineStatus(config)}

    <!-- Section 2: Quality Metrics -->
    ${renderQualityMetrics(feedback)}

    <!-- Section 3: Tier Distribution -->
    ${renderTierDistribution(feedback.byTier)}

    <!-- Section 4: Recent Activity -->
    ${renderRecentActivity(feedback.recentEntries)}

    <!-- Section 5: Budget Status -->
    ${budget ? renderBudgetStatus(budget) : nothing}
  `;
}

// ============================================================================
// Section 1: Pipeline Status
// ============================================================================

function renderPipelineStatus(config: IntelligenceStats["config"]) {
  return html`
    <section class="grid grid-cols-2" style="margin-bottom: 18px;">
      <div class="card">
        <div class="card-title">Pipeline Status</div>
        <div class="card-sub">Current intelligence pipeline state</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Intelligence</span>
            <span class="${config.enabled ? "ok" : "danger"}" style="font-family: var(--mono);">
              ${config.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Knowledge Source</span>
            <span style="font-family: var(--mono);">${config.knowledgeSource}</span>
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Chaining</span>
            <span class="${config.chainingEnabled ? "ok" : "muted"}" style="font-family: var(--mono);">
              ${config.chainingEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Sandbox</span>
            <span class="${config.sandboxEnabled ? "ok" : "muted"}" style="font-family: var(--mono);">
              ${config.sandboxEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Active Configuration</div>
        <div class="card-sub">Runtime parameters and thresholds</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
          <div class="row" style="justify-content: space-between;">
            <span class="muted">RAG Max Iterations</span>
            <span style="font-family: var(--mono);">${config.ragMaxIterations}</span>
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">RAG Relevance Threshold</span>
            <span style="font-family: var(--mono);">${config.ragRelevanceThreshold}</span>
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Chaining Complexity Threshold</span>
            <span style="font-family: var(--mono);">${config.chainingThreshold}</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 2: Quality Metrics
// ============================================================================

function renderQualityMetrics(feedback: IntelligenceStats["feedback"]) {
  const hasData = feedback.totalEntries > 0;

  return html`
    <section
      style="
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 18px;
      "
    >
      <div class="card" style="text-align: center; padding: 20px 12px;">
        <div class="stat-label">Avg Confidence</div>
        <div
          class="stat-value ${hasData ? confidenceColor(feedback.avgConfidence) : ""}"
          style="font-size: 1.75rem; font-family: var(--mono); margin-top: 8px;"
        >
          ${hasData ? pct(feedback.avgConfidence) : "--"}
        </div>
      </div>

      <div class="card" style="text-align: center; padding: 20px 12px;">
        <div class="stat-label">Coherence Rate</div>
        <div
          class="stat-value ${hasData ? confidenceColor(feedback.coherenceRate) : ""}"
          style="font-size: 1.75rem; font-family: var(--mono); margin-top: 8px;"
        >
          ${hasData ? pct(feedback.coherenceRate) : "--"}
        </div>
      </div>

      <div class="card" style="text-align: center; padding: 20px 12px;">
        <div class="stat-label">Refusal Rate</div>
        <div
          class="stat-value ${hasData ? refusalColor(feedback.refusalRate) : ""}"
          style="font-size: 1.75rem; font-family: var(--mono); margin-top: 8px;"
        >
          ${hasData ? pct(feedback.refusalRate) : "--"}
        </div>
      </div>

      <div class="card" style="text-align: center; padding: 20px 12px;">
        <div class="stat-label">Total Evaluations</div>
        <div
          class="stat-value"
          style="font-size: 1.75rem; font-family: var(--mono); margin-top: 8px;"
        >
          ${feedback.totalEntries.toLocaleString()}
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 3: Tier Distribution
// ============================================================================

function renderTierDistribution(
  byTier: Record<string, { count: number; avgConfidence: number }>,
) {
  const tiers = Object.keys(byTier);
  if (tiers.length === 0) {
    return html`
      <section class="card" style="margin-bottom: 18px;">
        <div class="card-title">Tier Distribution</div>
        <div class="card-sub">Model tier usage breakdown</div>
        <div class="muted" style="margin-top: 16px; text-align: center; padding: 24px 0;">
          No tier data recorded yet.
        </div>
      </section>
    `;
  }

  const tierOrder = ["tiny", "small", "medium", "large", "reasoning"];
  const sortedTiers = tiers.sort(
    (a, b) => (tierOrder.indexOf(a) === -1 ? 99 : tierOrder.indexOf(a)) -
              (tierOrder.indexOf(b) === -1 ? 99 : tierOrder.indexOf(b)),
  );
  const max = maxTierCount(byTier);

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Tier Distribution</div>
      <div class="card-sub">Model tier usage breakdown</div>
      <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
        ${sortedTiers.map((tier) => {
          const data = byTier[tier];
          const widthPct = Math.max(2, (data.count / max) * 100);
          return html`
            <div style="display: flex; align-items: center; gap: 12px;">
              <span
                style="
                  width: 80px;
                  flex-shrink: 0;
                  font-family: var(--mono);
                  font-size: 0.85rem;
                  color: var(--text);
                "
              >
                ${tier}
              </span>
              <div
                style="
                  flex: 1;
                  height: 24px;
                  background: var(--border);
                  border-radius: 4px;
                  overflow: hidden;
                  position: relative;
                "
              >
                <div
                  style="
                    width: ${widthPct}%;
                    height: 100%;
                    background: var(--accent);
                    border-radius: 4px;
                    transition: width 0.3s ease;
                  "
                ></div>
              </div>
              <span
                style="
                  width: 50px;
                  flex-shrink: 0;
                  text-align: right;
                  font-family: var(--mono);
                  font-size: 0.85rem;
                  color: var(--text);
                "
              >
                ${data.count}
              </span>
              <span
                class="${confidenceColor(data.avgConfidence)}"
                style="
                  width: 55px;
                  flex-shrink: 0;
                  text-align: right;
                  font-family: var(--mono);
                  font-size: 0.85rem;
                "
              >
                ${pct(data.avgConfidence)}
              </span>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

// ============================================================================
// Section 4: Recent Activity
// ============================================================================

function renderRecentActivity(
  entries: IntelligenceStats["feedback"]["recentEntries"],
) {
  if (!entries || entries.length === 0) {
    return html`
      <section class="card" style="margin-bottom: 18px;">
        <div class="card-title">Recent Activity</div>
        <div class="card-sub">Latest pipeline evaluations</div>
        <div class="muted" style="margin-top: 16px; text-align: center; padding: 24px 0;">
          No recent activity recorded yet.
        </div>
      </section>
    `;
  }

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Recent Activity</div>
      <div class="card-sub">Latest pipeline evaluations (last ${entries.length})</div>
      <div style="margin-top: 16px; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500;">Time</th>
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500;">Category</th>
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500;">Tier</th>
              <th style="text-align: right; padding: 6px 8px; color: var(--muted); font-weight: 500;">Confidence</th>
              <th style="text-align: center; padding: 6px 8px; color: var(--muted); font-weight: 500;">Coherent</th>
              <th style="text-align: center; padding: 6px 8px; color: var(--muted); font-weight: 500;">Refusal</th>
              <th style="text-align: center; padding: 6px 8px; color: var(--muted); font-weight: 500;">Chained</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(
              (entry) => html`
                <tr style="border-bottom: 1px solid var(--border);">
                  <td style="padding: 6px 8px; font-family: var(--mono); color: var(--text);">
                    ${formatTimestamp(entry.timestamp)}
                  </td>
                  <td style="padding: 6px 8px; color: var(--text);">
                    ${entry.category}
                  </td>
                  <td style="padding: 6px 8px; font-family: var(--mono); color: var(--text);">
                    ${entry.tier || "--"}
                  </td>
                  <td
                    class="${confidenceColor(entry.confidence)}"
                    style="padding: 6px 8px; text-align: right; font-family: var(--mono);"
                  >
                    ${pct(entry.confidence)}
                  </td>
                  <td style="padding: 6px 8px; text-align: center;">
                    <span class="${entry.coherent ? "ok" : "danger"}">
                      ${entry.coherent ? "\u2713" : "\u2717"}
                    </span>
                  </td>
                  <td style="padding: 6px 8px; text-align: center;">
                    <span class="${entry.refusalDetected ? "danger" : "ok"}">
                      ${entry.refusalDetected ? "\u2717" : "\u2713"}
                    </span>
                  </td>
                  <td style="padding: 6px 8px; text-align: center; color: var(--text);">
                    ${entry.chainedExecution ? "\u2713" : "--"}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 5: Budget Status
// ============================================================================

function renderBudgetStatus(budget: NonNullable<IntelligenceStats["budget"]>) {
  const tierKeys = Object.keys(budget.byTier);
  const maxTokens = tierKeys.reduce(
    (max, key) => Math.max(max, budget.byTier[key].tokens),
    1,
  );

  const dailyCostPct = budget.dailyCostCap > 0
    ? Math.min(100, (budget.dailyCost / budget.dailyCostCap) * 100)
    : 0;
  const sessionCostPct = budget.sessionCostCap > 0
    ? Math.min(100, (budget.sessionCost / budget.sessionCostCap) * 100)
    : 0;

  const dailyCostColor = dailyCostPct >= 90 ? "danger" : dailyCostPct >= 70 ? "warn" : "ok";
  const sessionCostColor = sessionCostPct >= 90 ? "danger" : sessionCostPct >= 70 ? "warn" : "ok";

  return html`
    <section class="grid grid-cols-2" style="margin-bottom: 18px;">
      <div class="card">
        <div class="card-title">Budget Status</div>
        <div class="card-sub">Token and cost usage tracking</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 14px;">
          <!-- Daily Cost -->
          <div>
            <div class="row" style="justify-content: space-between; margin-bottom: 4px;">
              <span class="muted">Daily Cost</span>
              <span class="${dailyCostColor}" style="font-family: var(--mono); font-size: 0.85rem;">
                $${budget.dailyCost.toFixed(2)} / $${budget.dailyCostCap.toFixed(2)}
              </span>
            </div>
            <div style="height: 8px; background: var(--border); border-radius: 4px; overflow: hidden;">
              <div
                style="
                  width: ${dailyCostPct}%;
                  height: 100%;
                  background: var(--${dailyCostColor === "ok" ? "accent" : dailyCostColor === "warn" ? "warn" : "danger"});
                  border-radius: 4px;
                  transition: width 0.3s ease;
                "
              ></div>
            </div>
          </div>
          <!-- Session Cost -->
          <div>
            <div class="row" style="justify-content: space-between; margin-bottom: 4px;">
              <span class="muted">Session Cost</span>
              <span class="${sessionCostColor}" style="font-family: var(--mono); font-size: 0.85rem;">
                $${budget.sessionCost.toFixed(2)} / $${budget.sessionCostCap.toFixed(2)}
              </span>
            </div>
            <div style="height: 8px; background: var(--border); border-radius: 4px; overflow: hidden;">
              <div
                style="
                  width: ${sessionCostPct}%;
                  height: 100%;
                  background: var(--${sessionCostColor === "ok" ? "accent" : sessionCostColor === "warn" ? "warn" : "danger"});
                  border-radius: 4px;
                  transition: width 0.3s ease;
                "
              ></div>
            </div>
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
        <div class="card-title">Usage by Tier</div>
        <div class="card-sub">Token consumption per model tier</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
          ${tierKeys.length === 0
            ? html`<div class="muted" style="text-align: center; padding: 24px 0;">No tier usage data.</div>`
            : tierKeys.map((tier) => {
                const data = budget.byTier[tier];
                const widthPct = Math.max(2, (data.tokens / maxTokens) * 100);
                return html`
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span
                      style="
                        width: 70px;
                        flex-shrink: 0;
                        font-family: var(--mono);
                        font-size: 0.85rem;
                        color: var(--text);
                      "
                    >
                      ${tier}
                    </span>
                    <div
                      style="
                        flex: 1;
                        height: 20px;
                        background: var(--border);
                        border-radius: 4px;
                        overflow: hidden;
                      "
                    >
                      <div
                        style="
                          width: ${widthPct}%;
                          height: 100%;
                          background: var(--accent);
                          border-radius: 4px;
                        "
                      ></div>
                    </div>
                    <span
                      style="
                        width: 80px;
                        flex-shrink: 0;
                        text-align: right;
                        font-family: var(--mono);
                        font-size: 0.8rem;
                        color: var(--text);
                      "
                    >
                      ${data.tokens.toLocaleString()}
                    </span>
                    <span
                      style="
                        width: 60px;
                        flex-shrink: 0;
                        text-align: right;
                        font-family: var(--mono);
                        font-size: 0.8rem;
                        color: var(--muted);
                      "
                    >
                      $${data.cost.toFixed(2)}
                    </span>
                  </div>
                `;
              })
          }
        </div>
      </div>
    </section>
  `;
}
