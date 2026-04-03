/**
 * Routing Dashboard View
 *
 * Displays the model routing configuration, tier definitions, domain
 * escalation rules, pipeline selection logic, and quality thresholds.
 * Complements the intelligence dashboard by focusing on HOW routing
 * decisions are made rather than the quality outcomes.
 *
 * Data sources:
 * - Static routing-authority configuration (tier definitions, domain
 *   escalations, pipeline rules, quality thresholds) -- these are the
 *   real values from the intelligence extension's routing-authority module
 * - Live data from /intelligence/dashboard endpoint (tier usage counts,
 *   pipeline distribution, active config)
 *
 * @module routing-dashboard
 */

import { html, nothing } from "lit";
import type { IntelligenceStats } from "./intelligence-dashboard.ts";

// ============================================================================
// Types
// ============================================================================

export type RoutingDashboardProps = {
  connected: boolean;
  loading: boolean;
  stats: IntelligenceStats | null;
  error: string | null;
  onRefresh: () => void;
};

// ============================================================================
// Routing Authority Configuration (mirrored from extension source)
// These are the actual tier definitions, domain escalations, pipeline rules,
// and quality thresholds from extensions/intelligence/src/config/routing-authority.ts
// ============================================================================

interface TierDef {
  name: string;
  maxComplexity: number;
  description: string;
  maxTokens: number;
}

const TIER_DEFINITIONS: TierDef[] = [
  { name: "tiny", maxComplexity: 0.2, description: "Quick factual lookups, simple formatting", maxTokens: 512 },
  { name: "small", maxComplexity: 0.4, description: "Simple code generation, explanations", maxTokens: 4096 },
  { name: "medium", maxComplexity: 0.6, description: "Standard code generation, refactoring", maxTokens: 8192 },
  { name: "large", maxComplexity: 0.85, description: "Complex code, security-sensitive tasks", maxTokens: 8192 },
  { name: "reasoning", maxComplexity: 1.0, description: "Algorithm design, architecture decisions", maxTokens: 8192 },
];

interface DomainEscalation {
  domain: string;
  tier: string;
  category: string;
}

const DOMAIN_ESCALATIONS: DomainEscalation[] = [
  { domain: "rate_limiter", tier: "large", category: "Code Patterns" },
  { domain: "sliding_window", tier: "large", category: "Code Patterns" },
  { domain: "token_bucket", tier: "large", category: "Code Patterns" },
  { domain: "leaky_bucket", tier: "large", category: "Code Patterns" },
  { domain: "cache", tier: "large", category: "Code Patterns" },
  { domain: "lru_cache", tier: "large", category: "Code Patterns" },
  { domain: "circuit_breaker", tier: "large", category: "Code Patterns" },
  { domain: "tree", tier: "large", category: "Data Structures" },
  { domain: "graph", tier: "large", category: "Data Structures" },
  { domain: "heap", tier: "large", category: "Data Structures" },
  { domain: "trie", tier: "large", category: "Data Structures" },
  { domain: "auth", tier: "large", category: "Security" },
  { domain: "authentication", tier: "large", category: "Security" },
  { domain: "authorization", tier: "large", category: "Security" },
  { domain: "security", tier: "large", category: "Security" },
  { domain: "encryption", tier: "large", category: "Security" },
  { domain: "jwt", tier: "large", category: "Security" },
  { domain: "oauth", tier: "large", category: "Security" },
  { domain: "api", tier: "medium", category: "Standard" },
  { domain: "database", tier: "medium", category: "Standard" },
  { domain: "middleware", tier: "medium", category: "Standard" },
];

interface TaskTypeMapping {
  taskType: string;
  tier: string;
}

const TASK_TYPE_MAPPINGS: TaskTypeMapping[] = [
  { taskType: "code_generation", tier: "large" },
  { taskType: "code_review", tier: "medium" },
  { taskType: "code_explanation", tier: "small" },
  { taskType: "debugging", tier: "large" },
  { taskType: "refactoring", tier: "large" },
  { taskType: "documentation", tier: "small" },
  { taskType: "testing", tier: "medium" },
  { taskType: "general", tier: "medium" },
];

const PIPELINE_RULES = {
  simple: { maxComplexity: 0.4, maxRequirements: 3 },
  complex: { minComplexity: 0.4, minRequirements: 4 },
};

const QUALITY_THRESHOLDS = {
  minAcceptable: 0.65,
  good: 0.75,
  high: 0.85,
  autoApprove: 0.9,
};

// ============================================================================
// Helpers
// ============================================================================

function tierColor(tier: string): string {
  switch (tier) {
    case "tiny": return "var(--muted)";
    case "small": return "var(--info)";
    case "medium": return "var(--accent)";
    case "large": return "var(--warn)";
    case "reasoning": return "var(--danger)";
    default: return "var(--text)";
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function complexityBarWidth(maxComplexity: number, prevMax: number): number {
  return Math.max(2, (maxComplexity - prevMax) * 100);
}

// ============================================================================
// Skeleton helpers
// ============================================================================

function skel(width: string, height = "14px") {
  return html`<span style="
    display: inline-block;
    width: ${width};
    height: ${height};
    background: var(--border);
    border-radius: 4px;
    animation: skeleton-pulse 1.8s ease-in-out infinite;
  "></span>`;
}

function renderSkeletonStyles() {
  return html`<style>
    @keyframes skeleton-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }
  </style>`;
}

// ============================================================================
// Main Render
// ============================================================================

export function renderRoutingDashboard(props: RoutingDashboardProps) {
  if (!props.connected) {
    return html`
      <section class="card" style="text-align: center; padding: 48px 24px;">
        <div class="card-title" style="font-size: 1.25rem;">Routing Dashboard</div>
        <div class="muted" style="margin-top: 12px;">
          Connect to the gateway to view model routing configuration and statistics.
        </div>
      </section>
    `;
  }

  const stats = props.stats;
  const skeleton = !stats || props.loading;

  return html`
    ${renderSkeletonStyles()}

    <!-- Header -->
    <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 18px;">
      <div>
        <div class="card-title" style="font-size: 1.25rem; margin: 0;">Routing Dashboard</div>
        <div class="muted">Model tier configuration, domain escalations, and routing rules</div>
      </div>
      <button
        class="btn"
        ?disabled=${props.loading}
        @click=${() => props.onRefresh()}
      >
        ${props.loading ? "Refreshing..." : "Refresh"}
      </button>
    </div>

    ${props.error
      ? html`<div class="callout danger" style="margin-bottom: 18px;">${props.error}</div>`
      : nothing
    }

    <!-- Section 1: Tier Configuration Cards -->
    ${renderTierCards(stats?.feedback?.byTier ?? null, skeleton)}

    <!-- Section 2: Complexity Spectrum -->
    ${renderComplexitySpectrum()}

    <!-- Section 3: Active Routing Config + Pipeline Rules -->
    ${renderRoutingConfig(stats?.config ?? null, skeleton)}

    <!-- Section 4: Domain Escalations -->
    ${renderDomainEscalations()}

    <!-- Section 5: Task Type Mappings -->
    ${renderTaskTypeMappings()}

    <!-- Section 6: Quality Thresholds -->
    ${renderQualityThresholds()}

    <!-- Section 7: Pipeline Usage (live data) -->
    ${renderPipelineUsage(stats?.feedback?.byPipeline ?? null, stats?.feedback?.totalEntries ?? 0, skeleton)}
  `;
}

// ============================================================================
// Section 1: Tier Configuration Cards
// ============================================================================

function renderTierCards(
  byTier: Record<string, { count: number; avgConfidence: number }> | null,
  skeleton: boolean,
) {
  return html`
    <section style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 18px;">
      ${TIER_DEFINITIONS.map((tier) => {
        const liveData = byTier?.[tier.name];
        const hasLive = !skeleton && liveData != null;
        return html`
          <div class="card" style="padding: 16px; position: relative; overflow: hidden;">
            <!-- Tier color indicator -->
            <div style="
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              height: 3px;
              background: ${tierColor(tier.name)};
            "></div>

            <div style="
              font-family: var(--mono);
              font-size: 0.95rem;
              font-weight: 600;
              color: ${tierColor(tier.name)};
              margin-bottom: 8px;
              text-transform: uppercase;
              letter-spacing: 0.04em;
            ">
              ${tier.name}
            </div>

            <div class="muted" style="font-size: 0.78rem; margin-bottom: 12px; line-height: 1.4;">
              ${tier.description}
            </div>

            <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem;">
              <div class="row" style="justify-content: space-between;">
                <span class="muted">Max Complexity</span>
                <span style="font-family: var(--mono); color: var(--text-strong);">${tier.maxComplexity.toFixed(2)}</span>
              </div>
              <div class="row" style="justify-content: space-between;">
                <span class="muted">Max Tokens</span>
                <span style="font-family: var(--mono); color: var(--text-strong);">${formatTokens(tier.maxTokens)}</span>
              </div>
              <div style="border-top: 1px solid var(--border); margin-top: 4px; padding-top: 6px;">
                <div class="row" style="justify-content: space-between;">
                  <span class="muted">Requests</span>
                  ${skeleton
                    ? skel("30px")
                    : html`<span style="font-family: var(--mono); color: var(--text-strong);">
                        ${hasLive ? liveData!.count.toLocaleString() : "0"}
                      </span>`
                  }
                </div>
                <div class="row" style="justify-content: space-between; margin-top: 4px;">
                  <span class="muted">Avg Confidence</span>
                  ${skeleton
                    ? skel("40px")
                    : html`<span style="font-family: var(--mono); color: ${hasLive && liveData!.avgConfidence >= 0.8 ? 'var(--ok)' : hasLive && liveData!.avgConfidence >= 0.6 ? 'var(--warn)' : hasLive ? 'var(--danger)' : 'var(--muted)'};">
                        ${hasLive ? pct(liveData!.avgConfidence) : "--"}
                      </span>`
                  }
                </div>
              </div>
            </div>
          </div>
        `;
      })}
    </section>
  `;
}

// ============================================================================
// Section 2: Complexity Spectrum
// ============================================================================

function renderComplexitySpectrum() {
  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Complexity Spectrum</div>
      <div class="card-sub">How complexity scores map to model tiers</div>
      <div style="margin-top: 16px;">
        <!-- Spectrum bar -->
        <div style="
          display: flex;
          height: 32px;
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid var(--border);
        ">
          ${TIER_DEFINITIONS.map((tier, i) => {
            const prev = i > 0 ? TIER_DEFINITIONS[i - 1].maxComplexity : 0;
            const width = complexityBarWidth(tier.maxComplexity, prev);
            return html`
              <div style="
                width: ${width}%;
                background: ${tierColor(tier.name)};
                opacity: 0.35;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.7rem;
                font-family: var(--mono);
                color: var(--text-strong);
                border-right: ${i < TIER_DEFINITIONS.length - 1 ? '1px solid var(--bg)' : 'none'};
                position: relative;
              " title="${tier.name}: 0-${tier.maxComplexity}">
                <span style="
                  position: relative;
                  z-index: 1;
                  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
                  font-weight: 500;
                ">${tier.name}</span>
              </div>
            `;
          })}
        </div>
        <!-- Scale labels -->
        <div style="
          display: flex;
          justify-content: space-between;
          margin-top: 6px;
          font-size: 0.72rem;
          font-family: var(--mono);
          color: var(--muted);
        ">
          <span>0.0</span>
          ${TIER_DEFINITIONS.map((tier) => html`
            <span>${tier.maxComplexity.toFixed(1)}</span>
          `)}
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 3: Active Routing Config + Pipeline Rules
// ============================================================================

function renderRoutingConfig(
  config: IntelligenceStats["config"] | null,
  skeleton: boolean,
) {
  return html`
    <section class="grid grid-cols-2" style="margin-bottom: 18px;">
      <div class="card">
        <div class="card-title">Active Routing Configuration</div>
        <div class="card-sub">Runtime routing parameters from gateway config</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Intelligence Routing</span>
            ${skeleton
              ? skel("60px")
              : html`<span class="${config?.enabled ? 'ok' : 'danger'}" style="font-family: var(--mono);">
                  ${config?.enabled ? "Active" : "Disabled"}
                </span>`
            }
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Chaining Enabled</span>
            ${skeleton
              ? skel("60px")
              : html`<span class="${config?.chainingEnabled ? 'ok' : 'muted'}" style="font-family: var(--mono);">
                  ${config?.chainingEnabled ? "Yes" : "No"}
                </span>`
            }
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Chaining Threshold</span>
            ${skeleton
              ? skel("40px")
              : html`<span style="font-family: var(--mono); color: var(--text-strong);">
                  ${config?.chainingThreshold?.toFixed(2) ?? "--"}
                </span>`
            }
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">Knowledge Source</span>
            ${skeleton
              ? skel("60px")
              : html`<span style="font-family: var(--mono); color: var(--text-strong);">
                  ${config?.knowledgeSource ?? "--"}
                </span>`
            }
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">RAG Max Iterations</span>
            ${skeleton
              ? skel("30px")
              : html`<span style="font-family: var(--mono); color: var(--text-strong);">
                  ${config?.ragMaxIterations ?? "--"}
                </span>`
            }
          </div>
          <div class="row" style="justify-content: space-between;">
            <span class="muted">RAG Relevance Threshold</span>
            ${skeleton
              ? skel("40px")
              : html`<span style="font-family: var(--mono); color: var(--text-strong);">
                  ${config?.ragRelevanceThreshold ?? "--"}
                </span>`
            }
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Pipeline Selection Rules</div>
        <div class="card-sub">How requests are classified as simple or complex</div>
        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 14px;">
          <!-- Simple pipeline -->
          <div>
            <div style="
              font-family: var(--mono);
              font-size: 0.85rem;
              color: var(--ok);
              margin-bottom: 6px;
              font-weight: 500;
            ">Simple Pipeline</div>
            <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem;">
              <div class="row" style="justify-content: space-between;">
                <span class="muted">Max Complexity</span>
                <span style="font-family: var(--mono); color: var(--text-strong);">${PIPELINE_RULES.simple.maxComplexity.toFixed(1)}</span>
              </div>
              <div class="row" style="justify-content: space-between;">
                <span class="muted">Max Requirements</span>
                <span style="font-family: var(--mono); color: var(--text-strong);">${PIPELINE_RULES.simple.maxRequirements}</span>
              </div>
            </div>
          </div>
          <!-- Complex pipeline -->
          <div>
            <div style="
              font-family: var(--mono);
              font-size: 0.85rem;
              color: var(--warn);
              margin-bottom: 6px;
              font-weight: 500;
            ">Complex Pipeline</div>
            <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem;">
              <div class="row" style="justify-content: space-between;">
                <span class="muted">Min Complexity</span>
                <span style="font-family: var(--mono); color: var(--text-strong);">${PIPELINE_RULES.complex.minComplexity.toFixed(1)}</span>
              </div>
              <div class="row" style="justify-content: space-between;">
                <span class="muted">Min Requirements</span>
                <span style="font-family: var(--mono); color: var(--text-strong);">${PIPELINE_RULES.complex.minRequirements}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 4: Domain Escalations
// ============================================================================

function renderDomainEscalations() {
  const categories = new Map<string, DomainEscalation[]>();
  for (const esc of DOMAIN_ESCALATIONS) {
    const list = categories.get(esc.category) ?? [];
    list.push(esc);
    categories.set(esc.category, list);
  }

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Domain Escalations</div>
      <div class="card-sub">
        Domains that force a minimum tier regardless of complexity score (requires complexity >= 0.3)
      </div>
      <div style="margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px;">
        ${Array.from(categories.entries()).map(([category, domains]) => html`
          <div style="
            padding: 12px;
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            background: var(--bg-accent);
          ">
            <div style="
              font-size: 0.82rem;
              font-weight: 500;
              color: var(--text-strong);
              margin-bottom: 10px;
              padding-bottom: 6px;
              border-bottom: 1px solid var(--border);
            ">${category}</div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
              ${domains.map((d) => html`
                <span style="
                  display: inline-flex;
                  align-items: center;
                  gap: 4px;
                  padding: 3px 8px;
                  background: var(--bg-elevated);
                  border: 1px solid var(--border);
                  border-radius: var(--radius-sm);
                  font-family: var(--mono);
                  font-size: 0.75rem;
                ">
                  <span style="color: var(--text);">${d.domain}</span>
                  <span style="color: ${tierColor(d.tier)}; font-weight: 500;">${d.tier}</span>
                </span>
              `)}
            </div>
          </div>
        `)}
      </div>
    </section>
  `;
}

// ============================================================================
// Section 5: Task Type Mappings
// ============================================================================

function renderTaskTypeMappings() {
  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Task Type Routing</div>
      <div class="card-sub">Default tier assignment by detected task type (overridden when complexity requires higher)</div>
      <div style="margin-top: 16px; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500;">Task Type</th>
              <th style="text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500;">Default Tier</th>
              <th style="text-align: right; padding: 6px 8px; color: var(--muted); font-weight: 500;">Max Complexity</th>
            </tr>
          </thead>
          <tbody>
            ${TASK_TYPE_MAPPINGS.map((mapping) => {
              const tierDef = TIER_DEFINITIONS.find((t) => t.name === mapping.tier);
              return html`
                <tr style="border-bottom: 1px solid var(--border);">
                  <td style="padding: 6px 8px; font-family: var(--mono); color: var(--text);">
                    ${mapping.taskType.replace(/_/g, " ")}
                  </td>
                  <td style="padding: 6px 8px;">
                    <span style="
                      font-family: var(--mono);
                      color: ${tierColor(mapping.tier)};
                      font-weight: 500;
                    ">${mapping.tier}</span>
                  </td>
                  <td style="padding: 6px 8px; text-align: right; font-family: var(--mono); color: var(--muted);">
                    ${tierDef ? tierDef.maxComplexity.toFixed(2) : "--"}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 6: Quality Thresholds
// ============================================================================

function renderQualityThresholds() {
  const thresholds = [
    { label: "Min Acceptable", value: QUALITY_THRESHOLDS.minAcceptable, color: "var(--danger)", desc: "Responses below this are rejected" },
    { label: "Good", value: QUALITY_THRESHOLDS.good, color: "var(--warn)", desc: "Sufficient for most tasks" },
    { label: "High", value: QUALITY_THRESHOLDS.high, color: "var(--ok)", desc: "Required for production/security" },
    { label: "Auto-Approve", value: QUALITY_THRESHOLDS.autoApprove, color: "var(--accent-2)", desc: "No human review needed" },
  ];

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Quality Thresholds</div>
      <div class="card-sub">Response quality gates that affect routing outcomes</div>
      <div style="margin-top: 16px;">
        <!-- Threshold bar -->
        <div style="position: relative; height: 40px; margin-bottom: 24px;">
          <div style="
            position: absolute;
            top: 14px;
            left: 0;
            right: 0;
            height: 12px;
            background: var(--border);
            border-radius: 6px;
            overflow: hidden;
          ">
            <div style="
              width: 100%;
              height: 100%;
              background: linear-gradient(
                to right,
                var(--danger) 0%,
                var(--danger) ${QUALITY_THRESHOLDS.minAcceptable * 100}%,
                var(--warn) ${QUALITY_THRESHOLDS.minAcceptable * 100}%,
                var(--warn) ${QUALITY_THRESHOLDS.good * 100}%,
                var(--ok) ${QUALITY_THRESHOLDS.good * 100}%,
                var(--ok) ${QUALITY_THRESHOLDS.high * 100}%,
                var(--accent-2) ${QUALITY_THRESHOLDS.high * 100}%,
                var(--accent-2) 100%
              );
              opacity: 0.4;
            "></div>
          </div>
          ${thresholds.map((t) => html`
            <div style="
              position: absolute;
              left: ${t.value * 100}%;
              top: 0;
              transform: translateX(-50%);
              display: flex;
              flex-direction: column;
              align-items: center;
            ">
              <div style="
                width: 2px;
                height: 40px;
                background: ${t.color};
                opacity: 0.7;
              "></div>
            </div>
          `)}
        </div>
        <!-- Threshold details -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
          ${thresholds.map((t) => html`
            <div style="text-align: center;">
              <div style="
                font-family: var(--mono);
                font-size: 1.1rem;
                font-weight: 600;
                color: ${t.color};
              ">${pct(t.value)}</div>
              <div style="
                font-size: 0.82rem;
                font-weight: 500;
                color: var(--text-strong);
                margin-top: 2px;
              ">${t.label}</div>
              <div class="muted" style="font-size: 0.72rem; margin-top: 2px;">${t.desc}</div>
            </div>
          `)}
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// Section 7: Pipeline Usage (live data)
// ============================================================================

function renderPipelineUsage(
  byPipeline: Record<string, { count: number; avgConfidence: number }> | null,
  totalEntries: number,
  skeleton: boolean,
) {
  const pipelines = byPipeline ? Object.keys(byPipeline) : [];
  const hasPipelineData = pipelines.length > 0 && totalEntries > 0;

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">Pipeline Distribution</div>
      <div class="card-sub">Live breakdown of simple vs complex pipeline usage</div>
      <div style="margin-top: 16px;">
        ${skeleton
          ? html`
              <div style="display: flex; gap: 12px;">
                <div style="flex: 1; height: 80px; background: var(--border); border-radius: 6px; animation: skeleton-pulse 1.8s ease-in-out infinite;"></div>
                <div style="flex: 1; height: 80px; background: var(--border); border-radius: 6px; animation: skeleton-pulse 1.8s ease-in-out infinite;"></div>
              </div>
            `
          : !hasPipelineData
            ? html`<div class="muted" style="text-align: center; padding: 24px 0;">No pipeline usage data recorded yet.</div>`
            : html`
                <!-- Stacked bar -->
                <div style="display: flex; height: 28px; border-radius: 6px; overflow: hidden; margin-bottom: 16px; border: 1px solid var(--border);">
                  ${pipelines.map((name) => {
                    const data = byPipeline![name];
                    const widthPct = totalEntries > 0 ? (data.count / totalEntries) * 100 : 0;
                    const color = name === "simple" ? "var(--ok)" : "var(--warn)";
                    return html`
                      <div style="
                        width: ${widthPct}%;
                        background: ${color};
                        opacity: 0.4;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 0.72rem;
                        font-family: var(--mono);
                        color: var(--text-strong);
                        min-width: ${widthPct > 5 ? '0' : '24'}px;
                      " title="${name}: ${data.count} (${pct(data.count / totalEntries)})">
                        <span style="text-shadow: 0 1px 2px rgba(0,0,0,0.5); font-weight: 500;">
                          ${widthPct > 10 ? `${name} ${pct(data.count / totalEntries)}` : ""}
                        </span>
                      </div>
                    `;
                  })}
                </div>
                <!-- Details -->
                <div style="display: grid; grid-template-columns: repeat(${pipelines.length}, 1fr); gap: 12px;">
                  ${pipelines.map((name) => {
                    const data = byPipeline![name];
                    const color = name === "simple" ? "var(--ok)" : "var(--warn)";
                    const confColor = data.avgConfidence >= 0.8 ? "var(--ok)" : data.avgConfidence >= 0.6 ? "var(--warn)" : "var(--danger)";
                    return html`
                      <div style="
                        padding: 12px;
                        border: 1px solid var(--border);
                        border-radius: var(--radius-md);
                        background: var(--bg-accent);
                      ">
                        <div style="
                          font-family: var(--mono);
                          font-size: 0.9rem;
                          font-weight: 500;
                          color: ${color};
                          margin-bottom: 8px;
                          text-transform: capitalize;
                        ">${name}</div>
                        <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.82rem;">
                          <div class="row" style="justify-content: space-between;">
                            <span class="muted">Requests</span>
                            <span style="font-family: var(--mono); color: var(--text-strong);">${data.count.toLocaleString()}</span>
                          </div>
                          <div class="row" style="justify-content: space-between;">
                            <span class="muted">Share</span>
                            <span style="font-family: var(--mono); color: var(--text-strong);">
                              ${totalEntries > 0 ? pct(data.count / totalEntries) : "--"}
                            </span>
                          </div>
                          <div class="row" style="justify-content: space-between;">
                            <span class="muted">Avg Confidence</span>
                            <span style="font-family: var(--mono); color: ${confColor};">
                              ${pct(data.avgConfidence)}
                            </span>
                          </div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
        }
      </div>
    </section>
  `;
}
