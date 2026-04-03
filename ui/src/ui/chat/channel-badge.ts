/**
 * Channel source badge for chat messages.
 *
 * Renders a small pill-style badge indicating which channel (WhatsApp,
 * Telegram, Slack, etc.) a message session originates from.
 */

import { html, nothing, type TemplateResult } from "lit";

type ChannelInfo = {
  label: string;
  abbrev: string;
  color: string;
};

/**
 * Known channel identifiers mapped to display metadata.
 * Colors are muted to avoid visual noise in the chat thread.
 */
const CHANNEL_MAP: Record<string, ChannelInfo> = {
  whatsapp: { label: "WhatsApp", abbrev: "WA", color: "#25d366" },
  telegram: { label: "Telegram", abbrev: "TG", color: "#2aabee" },
  discord: { label: "Discord", abbrev: "DC", color: "#5865f2" },
  slack: { label: "Slack", abbrev: "SK", color: "#e01e5a" },
  signal: { label: "Signal", abbrev: "SG", color: "#3a76f0" },
  bluebubbles: { label: "iMessage", abbrev: "iM", color: "#34c759" },
  imessage: { label: "iMessage", abbrev: "iM", color: "#34c759" },
  matrix: { label: "Matrix", abbrev: "MX", color: "#0dbd8b" },
  googlechat: { label: "Google Chat", abbrev: "GC", color: "#1a73e8" },
  msteams: { label: "Teams", abbrev: "MS", color: "#6264a7" },
  nostr: { label: "Nostr", abbrev: "NR", color: "#8b5cf6" },
  email: { label: "Email", abbrev: "EM", color: "#ea580c" },
  sms: { label: "SMS", abbrev: "SM", color: "#65a30d" },
  irc: { label: "IRC", abbrev: "IR", color: "#78756f" },
  mattermost: { label: "Mattermost", abbrev: "MM", color: "#0058cc" },
  line: { label: "LINE", abbrev: "LN", color: "#06c755" },
  twitch: { label: "Twitch", abbrev: "TW", color: "#9146ff" },
  feishu: { label: "Feishu", abbrev: "FS", color: "#3370ff" },
  nextcloudtalk: { label: "Nextcloud", abbrev: "NC", color: "#0082c9" },
  tlon: { label: "Tlon", abbrev: "TL", color: "#78756f" },
  zalo: { label: "Zalo", abbrev: "ZL", color: "#0068ff" },
  zalouser: { label: "Zalo", abbrev: "ZL", color: "#0068ff" },
  web: { label: "Web", abbrev: "WB", color: "#8a9ba8" },
  api: { label: "API", abbrev: "AP", color: "#8a9ba8" },
};

/**
 * Resolve a channel surface string into display metadata.
 * The surface may come from a session's `surface` field or be extracted
 * from the session key pattern `agent:<id>:<channel>:...`.
 */
function resolveChannelInfo(channel: string): ChannelInfo {
  const lower = channel.toLowerCase().trim();
  const known = CHANNEL_MAP[lower];
  if (known) {
    return known;
  }
  // Fallback: capitalize first letter, use first 2 chars as abbreviation
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  const abbrev = channel.slice(0, 2).toUpperCase();
  return { label, abbrev, color: "#78756f" };
}

/**
 * Extract the channel identifier from a session key.
 * Session keys follow the pattern: `agent:<agentId>:<channel>:<kind>:<id>`
 * Falls back to null if the key doesn't match the expected pattern.
 */
export function extractChannelFromSessionKey(sessionKey: string): string | null {
  // Pattern: agent:<agentId>:<channel>:<kind>:<rest>
  const match = sessionKey.match(/^agent:[^:]+:([^:]+):(direct|group):/);
  if (match) {
    return match[1];
  }
  // Legacy pattern: <channel>:<rest>
  for (const key of Object.keys(CHANNEL_MAP)) {
    if (sessionKey === key || sessionKey.startsWith(`${key}:`)) {
      return key;
    }
  }
  return null;
}

/**
 * Render a channel source badge.
 * Returns `nothing` if the channel is empty, null, or undefined.
 *
 * @param channel - Channel identifier (e.g., "whatsapp", "telegram")
 * @returns Lit TemplateResult for the badge, or `nothing`
 */
export function renderChannelBadge(channel: string | null | undefined): typeof nothing | TemplateResult {
  if (!channel) {
    return nothing;
  }
  const info = resolveChannelInfo(channel);
  // Use a muted version of the channel color for the dot indicator
  return html`
    <span
      class="chat-channel-badge"
      title="${info.label}"
    >
      <span
        class="chat-channel-badge__dot"
        style="background: ${info.color}"
      ></span>
      <span class="chat-channel-badge__label">${info.abbrev}</span>
    </span>
  `;
}

/**
 * Resolve the channel for a session, preferring the surface field,
 * then falling back to parsing the session key.
 */
export function resolveSessionChannel(
  surface: string | null | undefined,
  sessionKey: string,
): string | null {
  if (surface && surface.trim()) {
    return surface.trim();
  }
  return extractChannelFromSessionKey(sessionKey);
}
