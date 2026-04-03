import { html, nothing } from "lit";

/**
 * Renders a small notification count badge. Returns `nothing` when count is 0
 * or negative, so it can be safely inlined without conditional wrappers.
 *
 * Usage:
 *   ${renderBadge(unreadCount)}
 *
 * The badge uses `--accent` as its background by default. Override with
 * `--badge-bg` and `--badge-fg` CSS custom properties on the parent.
 */
export function renderBadge(count: number) {
  if (!count || count <= 0) {
    return nothing;
  }

  const display = count > 99 ? "99+" : String(count);

  return html`
    <span class="nav-badge" aria-label="${count} unread">${display}</span>
  `;
}
