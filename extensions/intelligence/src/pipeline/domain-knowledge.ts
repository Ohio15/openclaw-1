/**
 * Domain Knowledge Repository — Fallback Layer
 *
 * Previously contained hardcoded reference implementations (~600 lines).
 * Those have been migrated to shared-brain as semantically-indexed knowledge.
 *
 * This module now serves as:
 * 1. Fallback when shared-brain is unreachable (returns domain/trigger info only)
 * 2. Domain detection keywords for tier routing (used by control-plane.ts)
 * 3. Interface definitions consumed by the pipeline
 *
 * Primary knowledge retrieval is handled by knowledge-retrieval.ts
 *
 * @module domain-knowledge
 */

export interface KnowledgeEntry {
  domain: string;
  topic: string;
  description: string;
  implementation: string;
  triggers: string[];
}

export interface KnowledgeMatch extends KnowledgeEntry {
  key: string;
}

export interface KnowledgeSummary {
  key: string;
  domain: string;
  topic: string;
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
    implementation: "",
  },
  crdt: {
    domain: "realtime",
    topic: "CRDT (Conflict-free Replicated Data Type)",
    description: "Sequence CRDT for collaborative text editing",
    triggers: ["crdt", "conflict-free", "replicated data", "yjs", "automerge"],
    implementation: "",
  },
  websocketServer: {
    domain: "realtime",
    topic: "WebSocket Server with Rooms",
    description: "Production WebSocket server with room management and presence",
    triggers: ["websocket", "socket server", "rooms", "presence", "ws"],
    implementation: "",
  },
  jwtAuth: {
    domain: "auth",
    topic: "JWT Authentication System",
    description: "JWT auth with refresh tokens and RBAC",
    triggers: ["jwt", "authentication", "auth system", "login", "token"],
    implementation: "",
  },
};

/**
 * Get knowledge entries matching a request (trigger-based fallback).
 * Returns matches with empty implementations — use shared-brain for full content.
 */
export function getRelevantKnowledge(request: string): KnowledgeMatch[] {
  const lower = request.toLowerCase();
  const matches: KnowledgeMatch[] = [];

  for (const [key, entry] of Object.entries(ALL_KNOWLEDGE)) {
    for (const trigger of entry.triggers) {
      if (lower.includes(trigger.toLowerCase())) {
        matches.push({ key, ...entry });
        break;
      }
    }
  }

  return matches;
}

/**
 * Get specific knowledge by key.
 */
export function getKnowledge(key: string): KnowledgeEntry | null {
  return ALL_KNOWLEDGE[key] || null;
}

/**
 * Build context from relevant knowledge (fallback — returns topic/description only).
 * Full implementations are now in shared-brain; this returns minimal context
 * when shared-brain is unreachable.
 */
export function buildKnowledgeContext(request: string): string {
  const matches = getRelevantKnowledge(request);

  if (matches.length === 0) return "";

  const parts: string[] = ["## Domain Knowledge (fallback — shared-brain unavailable)\n"];

  for (const match of matches) {
    parts.push(`### ${match.topic}`);
    parts.push(match.description);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Get all available knowledge topics.
 */
export function listKnowledge(): KnowledgeSummary[] {
  return Object.entries(ALL_KNOWLEDGE).map(([key, entry]) => ({
    key,
    domain: entry.domain,
    topic: entry.topic,
    triggers: entry.triggers,
  }));
}

export interface DomainKnowledgeInstance {
  get: typeof getKnowledge;
  getRelevant: typeof getRelevantKnowledge;
  buildContext: typeof buildKnowledgeContext;
  list: typeof listKnowledge;
}

// Singleton
let knowledgeInstance: DomainKnowledgeInstance | null = null;

export function getDomainKnowledge(): DomainKnowledgeInstance {
  if (!knowledgeInstance) {
    knowledgeInstance = {
      get: getKnowledge,
      getRelevant: getRelevantKnowledge,
      buildContext: buildKnowledgeContext,
      list: listKnowledge,
    };
  }
  return knowledgeInstance;
}
