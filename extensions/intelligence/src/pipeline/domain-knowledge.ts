/**
 * Domain Knowledge Repository — Fallback Layer
 *
 * Serves as fallback when shared-brain is unreachable.
 * Returns domain/trigger info only (no implementations).
 *
 * Primary knowledge retrieval is handled by knowledge-retrieval.ts
 *
 * @module domain-knowledge
 */

interface KnowledgeEntry {
  domain: string;
  topic: string;
  description: string;
  triggers: string[];
}

/**
 * Domain knowledge stubs — triggers preserved for fallback detection,
 * implementations removed (now in shared-brain).
 */
const ALL_KNOWLEDGE: Record<string, KnowledgeEntry> = {
  operationalTransformation: {
    domain: "realtime",
    topic: "Operational Transformation (OT)",
    description: "OT implementation for text editing conflict resolution",
    triggers: ["ot", "operational transformation", "conflict resolution", "collaborative edit"],
  },
  crdt: {
    domain: "realtime",
    topic: "CRDT (Conflict-free Replicated Data Type)",
    description: "Sequence CRDT for collaborative text editing",
    triggers: ["crdt", "conflict-free", "replicated data", "yjs", "automerge"],
  },
  websocketServer: {
    domain: "realtime",
    topic: "WebSocket Server with Rooms",
    description: "Production WebSocket server with room management and presence",
    triggers: ["websocket", "socket server", "rooms", "presence", "ws"],
  },
  jwtAuth: {
    domain: "auth",
    topic: "JWT Authentication System",
    description: "JWT auth with refresh tokens and RBAC",
    triggers: ["jwt", "authentication", "auth system", "login", "token"],
  },
};

/**
 * Build context from relevant knowledge (fallback — returns topic/description only).
 * Full implementations are now in shared-brain; this returns minimal context
 * when shared-brain is unreachable.
 */
export function buildKnowledgeContext(request: string): string {
  const lower = request.toLowerCase();
  const matches: Array<KnowledgeEntry & { key: string }> = [];

  for (const [key, entry] of Object.entries(ALL_KNOWLEDGE)) {
    for (const trigger of entry.triggers) {
      if (lower.includes(trigger.toLowerCase())) {
        matches.push({ key, ...entry });
        break;
      }
    }
  }

  if (matches.length === 0) return "";

  const parts: string[] = ["## Domain Knowledge (fallback — shared-brain unavailable)\n"];

  for (const match of matches) {
    parts.push(`### ${match.topic}`);
    parts.push(match.description);
    parts.push("");
  }

  return parts.join("\n");
}
