/**
 * Agents Graph View — visual overview of all agents
 *
 * Renders three sections:
 *   1. Agent Cards Grid — each agent as a card with key metadata
 *   2. Comparison Table — side-by-side config comparison
 *   3. Delegation Info — coding agent delegation edges (if configured)
 *
 * No external dependencies — CSS Grid/Flexbox only, uses existing design tokens.
 */

import { html, nothing } from "lit";
import type { AgentGraphCard, AgentGraphData, DelegationEdge } from "../controllers/agent-graph.ts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AgentsGraphProps = {
  loading: boolean;
  error: string | null;
  graphData: AgentGraphData | null;
};

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderAgentsGraph(props: AgentsGraphProps) {
  if (props.loading && !props.graphData) {
    return html`
      <div class="card">
        <div class="card-title">Agent Overview</div>
        <div class="card-sub">Loading agent data...</div>
      </div>
    `;
  }

  if (props.error && !props.graphData) {
    return html`
      <div class="card">
        <div class="card-title">Agent Overview</div>
        <div class="callout danger" style="margin-top: 12px;">${props.error}</div>
      </div>
    `;
  }

  const data = props.graphData;
  if (!data || data.cards.length === 0) {
    return html`
      <div class="card">
        <div class="card-title">Agent Overview</div>
        <div class="card-sub">No agents configured.</div>
      </div>
    `;
  }

  return html`
    <div class="agent-graph-root">
      ${renderSummaryBar(data)}
      ${renderCardsGrid(data.cards)}
      ${renderComparisonTable(data.cards)}
      ${data.delegationEdges.length > 0 ? renderDelegationInfo(data.delegationEdges, data.cards) : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

function renderSummaryBar(data: AgentGraphData) {
  const activeChannels = data.channelOrder.length;
  const channelNames = data.channelOrder
    .map((id) => data.channelLabels[id] ?? id)
    .join(", ");

  return html`
    <section class="card agent-graph-summary">
      <div class="agent-graph-summary-grid">
        <div class="agent-graph-stat">
          <div class="agent-graph-stat-value">${data.cards.length}</div>
          <div class="agent-graph-stat-label">Agents</div>
        </div>
        <div class="agent-graph-stat">
          <div class="agent-graph-stat-value">${activeChannels}</div>
          <div class="agent-graph-stat-label">Channels</div>
        </div>
        <div class="agent-graph-stat">
          <div class="agent-graph-stat-value">${data.totalSessions}</div>
          <div class="agent-graph-stat-label">Sessions</div>
        </div>
        <div class="agent-graph-stat">
          <div class="agent-graph-stat-value">${data.delegationEdges.length}</div>
          <div class="agent-graph-stat-label">Delegation Links</div>
        </div>
      </div>
      ${
        channelNames
          ? html`<div class="agent-graph-channels-bar muted" style="margin-top: 10px; font-size: 12px;">
              Channels: ${channelNames}
            </div>`
          : nothing
      }
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Cards grid
// ---------------------------------------------------------------------------

function renderCardsGrid(cards: AgentGraphCard[]) {
  return html`
    <section class="agent-graph-cards-section">
      <div class="agent-graph-cards-grid">
        ${cards.map((card) => renderAgentCard(card))}
      </div>
    </section>
  `;
}

function renderAgentCard(card: AgentGraphCard) {
  const avatarContent = card.emoji || card.displayName.slice(0, 1);
  const fallbackLabel = card.fallbacks.length > 0
    ? `+${card.fallbacks.length} fallback${card.fallbacks.length > 1 ? "s" : ""}`
    : null;

  return html`
    <div class="card agent-graph-card">
      <div class="agent-graph-card-header">
        <div class="agent-avatar">${avatarContent}</div>
        <div class="agent-graph-card-title-group">
          <div class="agent-graph-card-name">${card.displayName}</div>
          <div class="agent-sub mono">${card.id}</div>
        </div>
        ${card.isDefault ? html`<span class="agent-pill">default</span>` : nothing}
      </div>

      ${card.identityTheme ? html`<div class="agent-graph-card-theme muted">${card.identityTheme}</div>` : nothing}

      <div class="agent-graph-card-meta">
        <div class="agent-graph-card-kv">
          <span class="label">Model</span>
          <span class="mono">${card.modelPrimary ?? card.model}</span>
          ${fallbackLabel ? html`<span class="agent-graph-badge muted">${fallbackLabel}</span>` : nothing}
        </div>
        <div class="agent-graph-card-kv">
          <span class="label">Skills</span>
          <span>${card.skillsLabel}</span>
        </div>
        <div class="agent-graph-card-kv">
          <span class="label">Tools</span>
          <span>${card.toolsProfile ?? "default"}</span>
          ${card.toolsDenyCount > 0 ? html`<span class="agent-graph-badge muted">${card.toolsDenyCount} denied</span>` : nothing}
          ${card.toolsAlsoAllowCount > 0 ? html`<span class="agent-graph-badge muted">+${card.toolsAlsoAllowCount} extra</span>` : nothing}
        </div>
        <div class="agent-graph-card-kv">
          <span class="label">Channels</span>
          <span>${card.channelLabels.length > 0 ? card.channelLabels.join(", ") : "none"}</span>
        </div>
        <div class="agent-graph-card-kv">
          <span class="label">Sessions</span>
          <span>${card.sessionCount > 0 ? String(card.sessionCount) : "0"}</span>
        </div>
        <div class="agent-graph-card-kv">
          <span class="label">Workspace</span>
          <span class="mono">${card.workspace}</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

function renderComparisonTable(cards: AgentGraphCard[]) {
  if (cards.length < 2) {
    return nothing;
  }

  const rows: Array<{ label: string; values: string[] }> = [
    {
      label: "Primary Model",
      values: cards.map((c) => c.modelPrimary ?? c.model),
    },
    {
      label: "Fallback Count",
      values: cards.map((c) => String(c.fallbacks.length)),
    },
    {
      label: "Fallbacks",
      values: cards.map((c) => c.fallbacks.join(", ") || "-"),
    },
    {
      label: "Tool Profile",
      values: cards.map((c) => c.toolsProfile ?? "default"),
    },
    {
      label: "Tools Denied",
      values: cards.map((c) => String(c.toolsDenyCount)),
    },
    {
      label: "Tools Extra Allowed",
      values: cards.map((c) => String(c.toolsAlsoAllowCount)),
    },
    {
      label: "Skills",
      values: cards.map((c) => c.skillsLabel),
    },
    {
      label: "Workspace",
      values: cards.map((c) => c.workspace),
    },
    {
      label: "Channels",
      values: cards.map((c) => String(c.channelLabels.length)),
    },
    {
      label: "Sessions",
      values: cards.map((c) => String(c.sessionCount)),
    },
    {
      label: "Default",
      values: cards.map((c) => c.isDefault ? "yes" : "no"),
    },
  ];

  // Filter out rows where all values are identical — they add no comparison value
  const filteredRows = rows.filter((row) => {
    const first = row.values[0];
    return row.values.some((v) => v !== first);
  });

  // If all agents are configured identically, show a message instead
  if (filteredRows.length === 0) {
    return html`
      <section class="card">
        <div class="card-title">Configuration Comparison</div>
        <div class="card-sub">All agents share identical configuration.</div>
      </section>
    `;
  }

  return html`
    <section class="card">
      <div class="card-title">Configuration Comparison</div>
      <div class="card-sub">Side-by-side comparison of agent configurations. Only differences are shown.</div>
      <div class="agent-graph-table-wrap" style="margin-top: 16px;">
        <table class="agent-graph-table">
          <thead>
            <tr>
              <th class="agent-graph-table-label">Property</th>
              ${cards.map(
                (c) => html`
                  <th>
                    <span style="display: inline-flex; align-items: center; gap: 6px;">
                      ${c.emoji ? html`<span>${c.emoji}</span>` : nothing}
                      <span>${c.displayName}</span>
                    </span>
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${filteredRows.map(
              (row) => html`
                <tr>
                  <td class="agent-graph-table-label label">${row.label}</td>
                  ${row.values.map(
                    (val) => html`<td class="mono">${val}</td>`,
                  )}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Delegation info
// ---------------------------------------------------------------------------

function renderDelegationInfo(edges: DelegationEdge[], cards: AgentGraphCard[]) {
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  return html`
    <section class="card">
      <div class="card-title">Delegation Links</div>
      <div class="card-sub">
        External coding agent delegation configured via the Intelligence extension.
      </div>
      <div class="agent-graph-delegation-list" style="margin-top: 16px;">
        ${edges.map((edge) => {
          const fromCard = cardMap.get(edge.fromAgentId);
          const fromName = fromCard?.displayName ?? edge.fromAgentId;
          const fromEmoji = fromCard?.emoji ?? "";
          return html`
            <div class="agent-graph-delegation-edge">
              <div class="agent-graph-delegation-from">
                ${fromEmoji ? html`<span class="agent-graph-delegation-emoji">${fromEmoji}</span>` : nothing}
                <span class="text-strong">${fromName}</span>
              </div>
              <div class="agent-graph-delegation-arrow">
                <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
                  <path d="M0 8h20M16 3l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <div class="agent-graph-delegation-to">
                <span class="agent-graph-delegation-target-icon">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/>
                    <path d="M4 7h8M4 9.5h5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                  </svg>
                </span>
                <span class="text-strong">${edge.toTarget}</span>
                <span class="agent-pill" style="font-size: 10px;">${edge.kind}</span>
              </div>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}
