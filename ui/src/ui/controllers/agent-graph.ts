/**
 * Agent Graph Controller
 *
 * Aggregates agent data from the agents list, config form, channels snapshot,
 * and sessions list into a structure suitable for the agents-graph overview view.
 *
 * Data sources:
 *   - agents.list          -> agent IDs, names, identity metadata
 *   - config form          -> model, fallbacks, workspace, skills filter, tools profile
 *   - channels.status      -> channel order, labels, accounts (shared across agents)
 *   - sessions.list        -> session count (currently not per-agent in the API)
 *   - codingAgentDelegation config -> external delegation targets
 */

import type {
  AgentIdentityResult,
  AgentsListResult,
  ChannelsStatusSnapshot,
  GatewayAgentRow,
  SessionsListResult,
} from "../types.ts";
import {
  buildAgentContext,
  resolveAgentConfig,
  resolveAgentEmoji,
  resolveModelFallbacks,
  resolveModelLabel,
  resolveModelPrimary,
  type AgentContext,
} from "../views/agents-utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentGraphCard = {
  id: string;
  displayName: string;
  emoji: string;
  isDefault: boolean;
  model: string;
  modelPrimary: string | null;
  fallbacks: string[];
  workspace: string;
  skillsLabel: string;
  skillCount: number | null;
  toolsProfile: string | null;
  toolsDenyCount: number;
  toolsAlsoAllowCount: number;
  channelIds: string[];
  channelLabels: string[];
  sessionCount: number;
  identityTheme: string;
};

export type DelegationEdge = {
  fromAgentId: string;
  toTarget: string;
  kind: "coding-agent" | "sub-agent";
  label: string;
};

export type AgentGraphData = {
  cards: AgentGraphCard[];
  delegationEdges: DelegationEdge[];
  channelOrder: string[];
  channelLabels: Record<string, string>;
  totalSessions: number;
};

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compileAgentGraphData(opts: {
  agentsList: AgentsListResult | null;
  configForm: Record<string, unknown> | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  sessionsResult: SessionsListResult | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
}): AgentGraphData {
  const { agentsList, configForm, channelsSnapshot, sessionsResult, agentIdentityById } = opts;

  const agents = agentsList?.agents ?? [];
  const defaultId = agentsList?.defaultId ?? null;
  const channelOrder = channelsSnapshot?.channelOrder ?? [];
  const channelLabelsMap = channelsSnapshot?.channelLabels ?? {};
  const channelAccounts = channelsSnapshot?.channelAccounts ?? {};

  // Build a set of channel IDs that have at least one enabled/configured account
  const activeChannelIds = new Set<string>();
  for (const [channelId, accounts] of Object.entries(channelAccounts)) {
    for (const account of accounts) {
      if (account.configured || account.enabled || account.running) {
        activeChannelIds.add(channelId);
        break;
      }
    }
  }

  // Session count — the API does not partition sessions by agent, so we report
  // total sessions and per-agent count is derived from sessionKey prefix matching
  // when available.
  const totalSessions = sessionsResult?.count ?? sessionsResult?.sessions?.length ?? 0;
  const sessionsByAgent = new Map<string, number>();
  if (sessionsResult?.sessions) {
    for (const session of sessionsResult.sessions) {
      // Session keys may encode the agent id as a prefix — this is best-effort
      const key = session.key ?? "";
      for (const agent of agents) {
        if (key.startsWith(agent.id + ":") || key.startsWith(agent.id + "/")) {
          sessionsByAgent.set(agent.id, (sessionsByAgent.get(agent.id) ?? 0) + 1);
        }
      }
    }
  }

  const cards: AgentGraphCard[] = agents.map((agent) => {
    const config = resolveAgentConfig(configForm, agent.id);
    const identity = agentIdentityById[agent.id] ?? null;

    const modelLabel = config.entry?.model
      ? resolveModelLabel(config.entry.model)
      : resolveModelLabel(config.defaults?.model);
    const modelPrimary = resolveModelPrimary(config.entry?.model)
      ?? resolveModelPrimary(config.defaults?.model)
      ?? null;
    const fallbacks = resolveModelFallbacks(config.entry?.model) ?? [];

    const workspace = config.entry?.workspace || config.defaults?.workspace || "default";
    const skillFilter = Array.isArray(config.entry?.skills) ? config.entry.skills : null;
    const skillCount = skillFilter?.length ?? null;
    const skillsLabel = skillFilter ? `${skillCount} selected` : "all skills";

    const toolsEntry = config.entry?.tools;
    const toolsProfile = toolsEntry?.profile ?? config.globalTools?.profile ?? null;
    const toolsDenyCount = Array.isArray(toolsEntry?.deny) ? toolsEntry.deny.length : 0;
    const toolsAlsoAllowCount = Array.isArray(toolsEntry?.alsoAllow) ? toolsEntry.alsoAllow.length : 0;

    // Channels — all agents share the same channel set in OpenClaw
    const agentChannelIds = [...activeChannelIds];
    const agentChannelLabels = agentChannelIds.map((id) => channelLabelsMap[id] ?? id);

    const emoji = resolveAgentEmoji(agent, identity);
    const displayName =
      identity?.name?.trim() ||
      agent.identity?.name?.trim() ||
      agent.name?.trim() ||
      agent.id;

    const isDefault = Boolean(defaultId && agent.id === defaultId);
    const sessionCount = sessionsByAgent.get(agent.id) ?? 0;
    const identityTheme = agent.identity?.theme?.trim() || "";

    return {
      id: agent.id,
      displayName,
      emoji,
      isDefault,
      model: modelLabel,
      modelPrimary,
      fallbacks,
      workspace,
      skillsLabel,
      skillCount,
      toolsProfile,
      toolsDenyCount,
      toolsAlsoAllowCount,
      channelIds: agentChannelIds,
      channelLabels: agentChannelLabels,
      sessionCount,
      identityTheme,
    };
  });

  // Delegation edges — extract from coding agent delegation config if present
  const delegationEdges: DelegationEdge[] = [];
  const cfgAny = configForm as Record<string, unknown> | null;
  const plugins = cfgAny?.plugins as Record<string, unknown> | undefined;
  const intellCfg = plugins?.intelligence as Record<string, unknown> | undefined;
  const codingDelegation = intellCfg?.codingAgentDelegation as Record<string, unknown> | undefined;

  if (codingDelegation?.enabled) {
    const delegationAgents = codingDelegation.agents as Record<string, unknown> | undefined;
    if (delegationAgents) {
      // Coding agent delegation is available to all OpenClaw agents (it is a tool),
      // but in practice the default agent is the primary delegator.
      const delegatorId = defaultId ?? agents[0]?.id;
      if (delegatorId) {
        for (const targetName of Object.keys(delegationAgents)) {
          delegationEdges.push({
            fromAgentId: delegatorId,
            toTarget: targetName,
            kind: "coding-agent",
            label: `Delegates coding tasks to ${targetName}`,
          });
        }
      }
    }
  }

  // Sub-agent orchestration is prompt-based (within one generation pass),
  // not a real agent-to-agent delegation — so we don't create edges for it.

  return {
    cards,
    delegationEdges,
    channelOrder,
    channelLabels: channelLabelsMap,
    totalSessions,
  };
}
