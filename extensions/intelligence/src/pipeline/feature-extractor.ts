/**
 * Feature Extractor for Learned Routing Classifier
 *
 * Extracts a numeric feature vector from a prompt string. Features capture
 * structural, syntactic, and semantic signals that correlate with routing
 * tier and pipeline decisions.
 *
 * @module feature-extractor
 */

// ============================================================================
// Feature Names (exported for interpretability)
// ============================================================================

export const FEATURE_NAMES: readonly string[] = [
  // Length features (0-2)
  "charCountNorm",
  "wordCountNorm",
  "lineCountNorm",

  // Code presence (3-7)
  "hasCodeBlock",
  "codeBlockCount",
  "codeLinesNorm",
  "hasInlineCode",
  "codeLanguageCount",

  // Question patterns (8-12)
  "startsWithQuestion",
  "isHowDoI",
  "isImplementX",
  "isExplainY",
  "isWhatIs",

  // Technical depth (13-17)
  "techKeywordCount",
  "frameworkMentions",
  "protocolMentions",
  "specificTechDepth",
  "hasVersionNumbers",

  // Scope signals (18-21)
  "scopeExpansionWords",
  "scopeReductionWords",
  "scopeNetSignal",
  "mentionsMultipleFiles",

  // Multi-step indicators (22-25)
  "numberedListItems",
  "bulletListItems",
  "hasSequenceWords",
  "requirementCount",

  // Domain keywords as features (26-33)
  "domainAuth",
  "domainDatabase",
  "domainAPI",
  "domainAlgorithm",
  "domainSecurity",
  "domainCache",
  "domainRealtime",
  "domainTesting",

  // Structural signals (34-37)
  "sentenceCount",
  "avgWordsPerSentence",
  "hasBoldOrHeaders",
  "paragraphCount",

  // Complexity proxies (38-41)
  "uniqueWordRatio",
  "conjunctionCount",
  "conditionalCount",
  "comparisonWords",
] as const;

// ============================================================================
// Feature Extraction
// ============================================================================

/**
 * Extract a flat numeric feature vector from a prompt string.
 * Returns an array of numbers with length === FEATURE_NAMES.length.
 */
export function extractFeatures(prompt: string): number[] {
  const features: number[] = new Array(FEATURE_NAMES.length).fill(0);
  const lower = prompt.toLowerCase();
  const words = prompt.split(/\s+/).filter((w) => w.length > 0);
  const lines = prompt.split(/\n/);

  // --- Length features (0-2) ---
  features[0] = Math.min(prompt.length / 2000, 1); // charCountNorm
  features[1] = Math.min(words.length / 300, 1); // wordCountNorm
  features[2] = Math.min(lines.length / 50, 1); // lineCountNorm

  // --- Code presence (3-7) ---
  const codeBlocks = prompt.match(/```[\s\S]*?```/g) || [];
  features[3] = codeBlocks.length > 0 ? 1 : 0; // hasCodeBlock
  features[4] = Math.min(codeBlocks.length / 5, 1); // codeBlockCount
  const codeLinesTotal = codeBlocks.reduce((sum, block) => {
    return sum + block.split("\n").length - 2; // subtract opening/closing ```
  }, 0);
  features[5] = Math.min(Math.max(codeLinesTotal, 0) / 50, 1); // codeLinesNorm
  features[6] = /`[^`]+`/.test(prompt) ? 1 : 0; // hasInlineCode
  const langTags = new Set(
    (prompt.match(/```(\w+)/g) || []).map((m) => m.slice(3)),
  );
  features[7] = Math.min(langTags.size / 3, 1); // codeLanguageCount

  // --- Question patterns (8-12) ---
  features[8] = /^\s*(what|how|why|when|where|who|which|can|does|is|are|do|should|could|would)\b/i.test(prompt) ? 1 : 0;
  features[9] = /\bhow\s+(do|can|would|should)\s+i\b/i.test(lower) ? 1 : 0; // isHowDoI
  features[10] = /\b(implement|build|create|develop|design|architect|construct|write)\b/i.test(lower) ? 1 : 0; // isImplementX
  features[11] = /\b(explain|describe|walk\s*me\s*through|tell\s*me\s*about)\b/i.test(lower) ? 1 : 0; // isExplainY
  features[12] = /\bwhat\s+(is|are|does|do)\b/i.test(lower) ? 1 : 0; // isWhatIs

  // --- Technical depth (13-17) ---
  const techKeywords = lower.match(
    /\b(typescript|javascript|python|rust|go|java|c\+\+|react|vue|angular|svelte|nextjs|next\.js|express|fastify|nestjs|django|flask|spring|docker|kubernetes|k8s|terraform|aws|gcp|azure|redis|elasticsearch|kafka|rabbitmq|grpc|graphql|websocket|socket\.io|prisma|sequelize|typeorm|drizzle|webpack|vite|rollup|esbuild|nginx|traefik|caddy)\b/g,
  ) || [];
  features[13] = Math.min(techKeywords.length / 10, 1); // techKeywordCount

  const frameworks = lower.match(
    /\b(react|vue|angular|svelte|nextjs|next\.js|express|fastify|nestjs|django|flask|spring|rails|laravel)\b/g,
  ) || [];
  features[14] = Math.min(frameworks.length / 5, 1); // frameworkMentions

  const protocols = lower.match(
    /\b(http|https|ws|wss|tcp|udp|grpc|graphql|rest|soap|mqtt|amqp|smtp|ftp|ssh)\b/g,
  ) || [];
  features[15] = Math.min(protocols.length / 5, 1); // protocolMentions

  // Specific technical depth: mentions of concrete patterns, algorithms, data structures
  const deepTech = lower.match(
    /\b(crdt|ot|operational\s*transform|raft|paxos|consensus|sharding|replication|partitioning|b-tree|lsm|wal|mvcc|acid|cap\s*theorem|eventual\s*consistency|two-phase|saga|cqrs|event\s*sourcing|merkle|bloom\s*filter|consistent\s*hash|virtual\s*dom|fiber|reconciliation|hydration|ssr|isr|ssg)\b/g,
  ) || [];
  features[16] = Math.min(deepTech.length / 5, 1); // specificTechDepth

  features[17] = /\b\d+\.\d+(\.\d+)?\b/.test(prompt) ? 1 : 0; // hasVersionNumbers

  // --- Scope signals (18-21) ---
  const expansionWords = (
    lower.match(
      /\b(entire|complete|full|comprehensive|all|every|whole|end-to-end|e2e|production|enterprise|scalable|robust|thorough)\b/g,
    ) || []
  ).length;
  features[18] = Math.min(expansionWords / 5, 1); // scopeExpansionWords

  const reductionWords = (
    lower.match(
      /\b(simple|just|only|basic|quick|brief|short|small|minimal|tiny|single|one)\b/g,
    ) || []
  ).length;
  features[19] = Math.min(reductionWords / 5, 1); // scopeReductionWords

  // Net scope signal: expansion - reduction, normalized to [-1, 1]
  const netScope = expansionWords - reductionWords;
  features[20] = Math.max(-1, Math.min(1, netScope / 3)); // scopeNetSignal

  features[21] = /\b(multi-?file|multiple\s*files|across\s*files|several\s*files|codebase|repository|monorepo)\b/i.test(lower) ? 1 : 0;

  // --- Multi-step indicators (22-25) ---
  const numberedItems = prompt.match(/^\s*\d+[.)]\s+/gm) || [];
  features[22] = Math.min(numberedItems.length / 10, 1); // numberedListItems

  const bulletItems = prompt.match(/^\s*[-*•]\s+/gm) || [];
  features[23] = Math.min(bulletItems.length / 10, 1); // bulletListItems

  features[24] = /\b(first|then|next|after\s*that|finally|step\s*\d|phase\s*\d|stage\s*\d)\b/i.test(lower) ? 1 : 0; // hasSequenceWords

  // Requirement-like language
  const requirements = (
    lower.match(/\b(must|should|need\s*to|require|ensure|shall|has\s*to|needs?\s*to)\b/g) || []
  ).length;
  features[25] = Math.min(requirements / 8, 1); // requirementCount

  // --- Domain keywords as features (26-33) ---
  features[26] = /\b(auth|jwt|oauth|session|login|permission|token|credential|password|sso|saml|openid)\b/i.test(lower) ? 1 : 0;
  features[27] = /\b(database|postgres|mysql|mongodb|sqlite|redis|sql|orm|prisma|sequelize|typeorm|drizzle|migration|schema|query|index|join|transaction)\b/i.test(lower) ? 1 : 0;
  features[28] = /\b(api|endpoint|route|rest|graphql|grpc|crud|middleware|request|response|controller|handler)\b/i.test(lower) ? 1 : 0;
  features[29] = /\b(algorithm|sort|search|tree|graph|heap|trie|hash|linked\s*list|stack|queue|dynamic\s*programming|recursion|bfs|dfs|dijkstra|binary\s*search|complexity|big-?o)\b/i.test(lower) ? 1 : 0;
  features[30] = /\b(security|encryption|hash|csrf|xss|injection|vulnerability|sanitize|escape|cors|firewall|audit|penetration|owasp)\b/i.test(lower) ? 1 : 0;
  features[31] = /\b(cache|caching|lru|memoize|ttl|invalidation|cdn|edge\s*cache|stale|warm)\b/i.test(lower) ? 1 : 0;
  features[32] = /\b(realtime|real-time|websocket|socket\.io|sse|server-sent|live\s*update|push\s*notification|pubsub|pub\/sub|streaming)\b/i.test(lower) ? 1 : 0;
  features[33] = /\b(test|testing|spec|assertion|mock|stub|jest|vitest|mocha|cypress|playwright|coverage|tdd|bdd|unit\s*test|integration\s*test|e2e)\b/i.test(lower) ? 1 : 0;

  // --- Structural signals (34-37) ---
  const sentences = prompt.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  features[34] = Math.min(sentences.length / 20, 1); // sentenceCount

  const avgWordsPerSentence =
    sentences.length > 0
      ? words.length / sentences.length
      : 0;
  features[35] = Math.min(avgWordsPerSentence / 30, 1); // avgWordsPerSentence

  features[36] = /(\*\*|##|###|#{1,6}\s)/.test(prompt) ? 1 : 0; // hasBoldOrHeaders

  const paragraphs = prompt.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  features[37] = Math.min(paragraphs.length / 10, 1); // paragraphCount

  // --- Complexity proxies (38-41) ---
  const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
  features[38] = words.length > 0 ? uniqueWords.size / words.length : 0; // uniqueWordRatio

  const conjunctions = (
    lower.match(/\b(and|also|plus|additionally|furthermore|moreover|as\s*well\s*as|along\s*with|together\s*with)\b/g) || []
  ).length;
  features[39] = Math.min(conjunctions / 8, 1); // conjunctionCount

  const conditionals = (
    lower.match(/\b(if|when|unless|while|although|however|but|except|otherwise)\b/g) || []
  ).length;
  features[40] = Math.min(conditionals / 8, 1); // conditionalCount

  const comparisons = (
    lower.match(/\b(vs|versus|compare|between|difference|better|worse|pros?\s*and\s*cons?|trade-?off|alternative)\b/g) || []
  ).length;
  features[41] = Math.min(comparisons / 5, 1); // comparisonWords

  return features;
}
