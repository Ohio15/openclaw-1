/**
 * Routing Dashboard Controller
 *
 * Fetches routing configuration and intelligence stats for the routing dashboard.
 * Uses the same /intelligence/dashboard HTTP endpoint that the intelligence
 * dashboard uses, but extracts routing-specific data (tier distribution,
 * pipeline usage, config).
 *
 * @module routing-controller
 */

import type { IntelligenceStats } from "../views/intelligence-dashboard.ts";

// ============================================================================
// State
// ============================================================================

export type RoutingState = {
  gatewayUrl: string;
  token: string;
  connected: boolean;
  routingLoading: boolean;
  routingStats: IntelligenceStats | null;
  routingError: string | null;
};

// ============================================================================
// Data Fetching
// ============================================================================

/**
 * Load routing data from the intelligence dashboard HTTP endpoint.
 * Extracts tier distribution, pipeline usage, and configuration data
 * relevant to model routing decisions.
 */
export async function loadRoutingData(state: RoutingState): Promise<void> {
  if (!state.connected) {
    return;
  }
  if (state.routingLoading) {
    return;
  }
  state.routingLoading = true;
  state.routingError = null;
  try {
    const baseUrl = state.gatewayUrl
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
    }
    const res = await fetch(`${baseUrl}/intelligence/dashboard`, { headers });
    if (res.ok) {
      state.routingStats = (await res.json()) as IntelligenceStats;
    } else {
      state.routingError = `HTTP ${res.status}: ${res.statusText}`;
      state.routingStats = null;
    }
  } catch (err) {
    state.routingError = String(err);
    state.routingStats = null;
  } finally {
    state.routingLoading = false;
  }
}
