import type { GatewayHelloOk } from "../gateway.ts";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CostUsageDailyEntry,
  CostUsageSummary,
  CronJob,
  CronStatus,
  LogEntry,
  PresenceEntry,
  SessionsUsageResult,
  SessionsUsageTotals,
} from "../types.ts";
import type { IntelligenceStats } from "../views/intelligence-dashboard.ts";

// ============================================================================
// Types
// ============================================================================

export type ChannelHealthEntry = {
  id: string;
  label: string;
  configured: boolean;
  running: boolean;
  connected: boolean | null;
  lastError: string | null;
  lastProbeAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  accountCount: number;
  accounts: ChannelAccountHealthEntry[];
};

export type ChannelAccountHealthEntry = {
  accountId: string;
  name: string | null;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected: boolean | null;
  lastError: string | null;
  lastProbeAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  reconnectAttempts: number;
};

export type BudgetSnapshot = {
  dailyTokens: number;
  dailyCost: number;
  dailyCostCap: number;
  sessionCost: number;
  sessionCostCap: number;
  byTier: Record<string, { tokens: number; cost: number; requests: number }>;
};

export type UsageSummarySnapshot = {
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
  topModels: Array<{ model: string; provider: string; tokens: number; cost: number }>;
  topChannels: Array<{ channel: string; tokens: number; cost: number }>;
  errorCount: number;
  messageCount: number;
  toolCallCount: number;
  latency: { avgMs: number; p95Ms: number } | null;
  costDaily: CostUsageDailyEntry[];
};

export type CronSummary = {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
  nextWakeAtMs: number | null;
  recentErrors: Array<{ jobName: string; error: string; lastRunAtMs: number }>;
};

export type RecentLogError = {
  time: string | null;
  subsystem: string | null;
  message: string | null;
};

export type SystemHealthSnapshot = {
  connected: boolean;
  uptimeMs: number | null;
  tickIntervalMs: number | null;
  authMode: string | null;
  gatewayVersion: string | null;
  instanceCount: number;
  sessionCount: number | null;
};

export type MetricsDashboardData = {
  systemHealth: SystemHealthSnapshot;
  budget: BudgetSnapshot | null;
  channels: ChannelHealthEntry[];
  usageSummary: UsageSummarySnapshot | null;
  cronSummary: CronSummary | null;
  recentErrors: RecentLogError[];
};

// ============================================================================
// Aggregation
// ============================================================================

export function buildMetricsDashboardData(opts: {
  connected: boolean;
  hello: GatewayHelloOk | null;
  presenceEntries: PresenceEntry[];
  sessionsCount: number | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  intelligenceStats: IntelligenceStats | null;
  cronStatus: CronStatus | null;
  cronJobs: CronJob[];
  logsEntries: LogEntry[];
}): MetricsDashboardData {
  return {
    systemHealth: buildSystemHealth(opts),
    budget: extractBudget(opts.intelligenceStats),
    channels: extractChannelHealth(opts.channelsSnapshot),
    usageSummary: extractUsageSummary(opts.usageResult, opts.usageCostSummary),
    cronSummary: extractCronSummary(opts.cronStatus, opts.cronJobs),
    recentErrors: extractRecentErrors(opts.logsEntries),
  };
}

function buildSystemHealth(opts: {
  connected: boolean;
  hello: GatewayHelloOk | null;
  presenceEntries: PresenceEntry[];
  sessionsCount: number | null;
}): SystemHealthSnapshot {
  const snapshot = opts.hello?.snapshot as
    | {
        uptimeMs?: number;
        policy?: { tickIntervalMs?: number };
        authMode?: string;
        version?: string;
      }
    | undefined;

  // Try to extract version from presence entries or hello payload
  const version =
    snapshot?.version ??
    opts.presenceEntries.find((e) => e.version)?.version ??
    null;

  return {
    connected: opts.connected,
    uptimeMs: snapshot?.uptimeMs ?? null,
    tickIntervalMs: snapshot?.policy?.tickIntervalMs ?? null,
    authMode: snapshot?.authMode ?? null,
    gatewayVersion: version,
    instanceCount: opts.presenceEntries.length,
    sessionCount: opts.sessionsCount,
  };
}

function extractBudget(stats: IntelligenceStats | null): BudgetSnapshot | null {
  if (!stats?.budget) {
    return null;
  }
  const b = stats.budget;
  return {
    dailyTokens: b.dailyTokens,
    dailyCost: b.dailyCost,
    dailyCostCap: b.dailyCostCap,
    sessionCost: b.sessionCost,
    sessionCostCap: b.sessionCostCap,
    byTier: b.byTier,
  };
}

function extractChannelHealth(
  snapshot: ChannelsStatusSnapshot | null,
): ChannelHealthEntry[] {
  if (!snapshot) {
    return [];
  }

  const order =
    snapshot.channelMeta?.map((e) => e.id) ??
    snapshot.channelOrder ??
    [];

  const channels = snapshot.channels as Record<string, Record<string, unknown>> | null;
  const accounts = snapshot.channelAccounts ?? {};
  const labels = snapshot.channelLabels ?? {};
  const metaMap = new Map(
    (snapshot.channelMeta ?? []).map((e) => [e.id, e]),
  );

  return order.map((id) => {
    const status = channels?.[id] ?? {};
    const channelAccounts = accounts[id] ?? [];
    const meta = metaMap.get(id);
    const label = meta?.label ?? labels[id] ?? id;

    const accountEntries: ChannelAccountHealthEntry[] = channelAccounts.map(
      (acct: ChannelAccountSnapshot) => ({
        accountId: acct.accountId,
        name: acct.name ?? null,
        enabled: acct.enabled ?? false,
        configured: acct.configured ?? false,
        running: acct.running ?? false,
        connected: acct.connected ?? null,
        lastError: acct.lastError ?? null,
        lastProbeAt: acct.lastProbeAt ?? null,
        lastInboundAt: acct.lastInboundAt ?? null,
        lastOutboundAt: acct.lastOutboundAt ?? null,
        reconnectAttempts: acct.reconnectAttempts ?? 0,
      }),
    );

    // Derive top-level status from accounts if present, otherwise from channel status object
    const hasAccounts = accountEntries.length > 0;
    const configured = hasAccounts
      ? accountEntries.some((a) => a.configured)
      : (status.configured as boolean | undefined) ?? false;
    const running = hasAccounts
      ? accountEntries.some((a) => a.running)
      : (status.running as boolean | undefined) ?? false;
    const connected = hasAccounts
      ? accountEntries.some((a) => a.connected === true)
        ? true
        : accountEntries.every((a) => a.connected === false)
          ? false
          : null
      : (status.connected as boolean | undefined) ?? null;
    const lastError = hasAccounts
      ? accountEntries.find((a) => a.lastError)?.lastError ?? null
      : (status.lastError as string | undefined) ?? null;
    const lastProbeAt = hasAccounts
      ? Math.max(0, ...accountEntries.map((a) => a.lastProbeAt ?? 0)) || null
      : (status.lastProbeAt as number | undefined) ?? null;
    const lastInboundAt = hasAccounts
      ? Math.max(0, ...accountEntries.map((a) => a.lastInboundAt ?? 0)) || null
      : null;
    const lastOutboundAt = hasAccounts
      ? Math.max(0, ...accountEntries.map((a) => a.lastOutboundAt ?? 0)) || null
      : null;

    return {
      id,
      label,
      configured,
      running,
      connected,
      lastError,
      lastProbeAt,
      lastInboundAt,
      lastOutboundAt,
      accountCount: accountEntries.length,
      accounts: accountEntries,
    };
  });
}

function extractUsageSummary(
  result: SessionsUsageResult | null,
  costSummary: CostUsageSummary | null,
): UsageSummarySnapshot | null {
  if (!result && !costSummary) {
    return null;
  }

  const totals: SessionsUsageTotals = result?.totals ?? costSummary?.totals ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };

  const agg = result?.aggregates;

  const topModels = (agg?.byModel ?? [])
    .toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens)
    .slice(0, 5)
    .map((entry) => ({
      model: entry.model ?? "unknown",
      provider: entry.provider ?? "unknown",
      tokens: entry.totals.totalTokens,
      cost: entry.totals.totalCost,
    }));

  const topChannels = (agg?.byChannel ?? [])
    .toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens)
    .slice(0, 5)
    .map((entry) => ({
      channel: entry.channel,
      tokens: entry.totals.totalTokens,
      cost: entry.totals.totalCost,
    }));

  const latency = agg?.latency
    ? { avgMs: agg.latency.avgMs, p95Ms: agg.latency.p95Ms }
    : null;

  return {
    totalTokens: totals.totalTokens,
    totalCost: totals.totalCost,
    sessionCount: result?.sessions?.length ?? 0,
    topModels,
    topChannels,
    errorCount: agg?.messages?.errors ?? 0,
    messageCount: agg?.messages?.total ?? 0,
    toolCallCount: agg?.tools?.totalCalls ?? 0,
    latency,
    costDaily: costSummary?.daily ?? [],
  };
}

function extractCronSummary(
  status: CronStatus | null,
  jobs: CronJob[],
): CronSummary | null {
  if (!status) {
    return null;
  }

  const recentErrors: CronSummary["recentErrors"] = [];
  for (const job of jobs) {
    if (job.state?.lastStatus === "error" && job.state.lastError) {
      recentErrors.push({
        jobName: job.name,
        error: job.state.lastError,
        lastRunAtMs: job.state.lastRunAtMs ?? 0,
      });
    }
  }
  recentErrors.sort((a, b) => b.lastRunAtMs - a.lastRunAtMs);

  return {
    enabled: status.enabled,
    totalJobs: jobs.length,
    enabledJobs: jobs.filter((j) => j.enabled).length,
    nextWakeAtMs: status.nextWakeAtMs ?? null,
    recentErrors: recentErrors.slice(0, 5),
  };
}

function extractRecentErrors(entries: LogEntry[]): RecentLogError[] {
  return entries
    .filter((e) => e.level === "error" || e.level === "fatal")
    .slice(-10)
    .reverse()
    .map((e) => ({
      time: e.time ?? null,
      subsystem: e.subsystem ?? null,
      message: e.message ?? e.raw,
    }));
}
