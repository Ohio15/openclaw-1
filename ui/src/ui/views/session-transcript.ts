import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow } from "../types.ts";

/**
 * Preview item returned by the `sessions.preview` gateway method.
 * Each item represents a single message in the transcript.
 */
export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionTranscriptState = {
  /** The session key whose transcript is currently expanded, or null if none. */
  expandedKey: string | null;
  /** Whether the preview request is in flight. */
  loading: boolean;
  /** Fetched preview items for the currently expanded session. */
  items: SessionPreviewItem[];
  /** Error message from the preview fetch, if any. */
  error: string | null;
};

export function createSessionTranscriptState(): SessionTranscriptState {
  return {
    expandedKey: null,
    loading: false,
    items: [],
    error: null,
  };
}

/**
 * Toggle the transcript panel for a session row. If the same key is already
 * expanded, collapse it. Otherwise, fetch the preview and expand.
 */
export async function toggleSessionTranscript(
  state: SessionTranscriptState,
  key: string,
  client: GatewayBrowserClient | null,
  requestUpdate: () => void,
): Promise<void> {
  // Collapse if already expanded
  if (state.expandedKey === key) {
    state.expandedKey = null;
    state.items = [];
    state.error = null;
    requestUpdate();
    return;
  }

  // Expand new session
  state.expandedKey = key;
  state.items = [];
  state.error = null;
  state.loading = true;
  requestUpdate();

  if (!client) {
    state.loading = false;
    state.error = "Not connected to gateway";
    requestUpdate();
    return;
  }

  try {
    const result = await client.request<SessionsPreviewResult>("sessions.preview", {
      keys: [key],
      limit: 50,
      maxChars: 600,
    });

    const entry = result?.previews?.[0];
    if (!entry) {
      state.error = "No preview data returned";
    } else if (entry.status === "missing") {
      state.error = "Session transcript not found";
    } else if (entry.status === "error") {
      state.error = "Failed to read transcript";
    } else if (entry.status === "empty" || entry.items.length === 0) {
      state.error = "Transcript is empty";
    } else {
      state.items = entry.items;
    }
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
    requestUpdate();
  }
}

const ROLE_LABELS: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
  other: "Other",
};

const ROLE_CLASSES: Record<string, string> = {
  user: "transcript-role--user",
  assistant: "transcript-role--assistant",
  tool: "transcript-role--tool",
  system: "transcript-role--system",
  other: "transcript-role--other",
};

export type SessionTranscriptProps = {
  row: GatewaySessionRow;
  state: SessionTranscriptState;
};

/**
 * Renders the expandable transcript panel that sits beneath a session row.
 * Returns `nothing` if this session is not the currently expanded one.
 */
export function renderSessionTranscript(props: SessionTranscriptProps) {
  const { row, state } = props;
  if (state.expandedKey !== row.key) {
    return nothing;
  }

  return html`
    <div class="transcript-panel">
      <div class="transcript-header">
        <span class="transcript-title">Transcript Preview</span>
        <span class="transcript-meta">
          ${row.model ? html`<span class="transcript-chip">${row.model}</span>` : nothing}
          ${row.surface ? html`<span class="transcript-chip">${row.surface}</span>` : nothing}
          ${row.kind ? html`<span class="transcript-chip">${row.kind}</span>` : nothing}
        </span>
      </div>

      ${state.loading
        ? html`<div class="transcript-loading">Loading transcript...</div>`
        : nothing}

      ${state.error
        ? html`<div class="transcript-empty">${state.error}</div>`
        : nothing}

      ${!state.loading && !state.error && state.items.length > 0
        ? html`
            <div class="transcript-messages">
              ${state.items.map(
                (item) => html`
                  <div class="transcript-message">
                    <span class="transcript-role ${ROLE_CLASSES[item.role] ?? ""}">
                      ${ROLE_LABELS[item.role] ?? item.role}
                    </span>
                    <span class="transcript-text">${item.text}</span>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}
