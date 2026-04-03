import { html, nothing } from "lit";

export type ConfigHistoryEntry = {
  timestamp: number;
  hash: string;
  config: Record<string, unknown>;
  label: string;
  changedFields: string[];
};

export type ConfigHistoryProps = {
  entries: ConfigHistoryEntry[];
  visible: boolean;
  selectedIndex: number | null;
  onToggle: () => void;
  onSelect: (index: number) => void;
  onRestore: (index: number) => void;
  onClear: () => void;
};

const historyIcon = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"></circle>
    <polyline points="12 6 12 12 16 14"></polyline>
  </svg>
`;

const restoreIcon = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="1 4 1 10 7 10"></polyline>
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
  </svg>
`;

const trashIcon = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </svg>
`;

const chevronIcon = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="15 18 9 12 15 6"></polyline>
  </svg>
`;

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  let relative: string;
  if (diffMins < 1) {
    relative = "just now";
  } else if (diffMins < 60) {
    relative = `${diffMins}m ago`;
  } else if (diffHours < 24) {
    relative = `${diffHours}h ago`;
  } else if (diffDays < 7) {
    relative = `${diffDays}d ago`;
  } else {
    relative = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return `${relative} (${time})`;
}

function truncateHash(hash: string): string {
  if (hash.length <= 10) {
    return hash;
  }
  return hash.slice(0, 8) + "...";
}

export function renderConfigHistoryToggle(props: ConfigHistoryProps) {
  return html`
    <button
      class="config-history-toggle ${props.visible ? "active" : ""}"
      @click=${props.onToggle}
      title="Config version history"
    >
      <span class="config-history-toggle__icon">${historyIcon}</span>
      <span class="config-history-toggle__label">History</span>
      ${
        props.entries.length > 0
          ? html`<span class="config-history-toggle__count">${props.entries.length}</span>`
          : nothing
      }
    </button>
  `;
}

export function renderConfigHistoryPanel(props: ConfigHistoryProps) {
  if (!props.visible) {
    return nothing;
  }

  return html`
    <aside class="config-history-panel">
      <div class="config-history-panel__header">
        <button class="config-history-panel__back" @click=${props.onToggle}>
          ${chevronIcon}
        </button>
        <div class="config-history-panel__title">Version History</div>
        ${
          props.entries.length > 0
            ? html`
              <button
                class="config-history-panel__clear"
                @click=${props.onClear}
                title="Clear all history"
              >
                ${trashIcon}
              </button>
            `
            : nothing
        }
      </div>

      <div class="config-history-panel__list">
        ${
          props.entries.length === 0
            ? html`
              <div class="config-history-panel__empty">
                <div class="config-history-panel__empty-icon">${historyIcon}</div>
                <div class="config-history-panel__empty-text">
                  No saved versions yet. Versions are recorded each time you save or apply config changes.
                </div>
              </div>
            `
            : props.entries.map(
                (entry, index) => html`
                  <div
                    class="config-history-entry ${props.selectedIndex === index ? "selected" : ""}"
                    @click=${() => props.onSelect(index)}
                  >
                    <div class="config-history-entry__header">
                      <span class="config-history-entry__time">
                        ${formatTimestamp(entry.timestamp)}
                      </span>
                      <span class="config-history-entry__hash" title=${entry.hash}>
                        ${truncateHash(entry.hash)}
                      </span>
                    </div>
                    ${
                      entry.label
                        ? html`<div class="config-history-entry__label">${entry.label}</div>`
                        : nothing
                    }
                    ${
                      entry.changedFields.length > 0
                        ? html`
                          <div class="config-history-entry__changes">
                            ${entry.changedFields.slice(0, 5).map(
                              (field) => html`
                                <span class="config-history-entry__field">${field}</span>
                              `,
                            )}
                            ${
                              entry.changedFields.length > 5
                                ? html`<span class="config-history-entry__field config-history-entry__field--more">
                                    +${entry.changedFields.length - 5} more
                                  </span>`
                                : nothing
                            }
                          </div>
                        `
                        : nothing
                    }
                    ${
                      props.selectedIndex === index
                        ? html`
                          <div class="config-history-entry__actions">
                            <button
                              class="config-history-entry__restore"
                              @click=${(e: Event) => {
                                e.stopPropagation();
                                props.onRestore(index);
                              }}
                            >
                              <span class="config-history-entry__restore-icon">${restoreIcon}</span>
                              Restore this version
                            </button>
                          </div>
                        `
                        : nothing
                    }
                  </div>
                `,
              )
        }
      </div>
    </aside>
  `;
}
