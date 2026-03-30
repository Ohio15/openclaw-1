/**
 * ClawHub Registry — Remote skill discovery and installation.
 *
 * Provides ability to search, list, and install community skills
 * from a configurable registry URL.
 */

export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  url: string;
  domains?: string[];
  minComplexity?: number;
  tags?: string[];
  downloads?: number;
  version?: string;
}

export interface RegistryIndex {
  version: string;
  updated: string;
  skills: RegistryEntry[];
}

const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/openclaw/clawhub-registry/main/index.json";
const FETCH_TIMEOUT_MS = 10_000;

let cachedRegistry: RegistryIndex | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch the skill registry index. Caches for 30 minutes.
 */
export async function fetchRegistry(
  registryUrl?: string,
): Promise<RegistryIndex | null> {
  if (cachedRegistry && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedRegistry;
  }

  const url = registryUrl || process.env.CLAWHUB_REGISTRY_URL || DEFAULT_REGISTRY_URL;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.warn(`[clawhub] Failed to fetch registry: HTTP ${res.status}`);
      return cachedRegistry; // Return stale cache if available
    }

    const data = (await res.json()) as RegistryIndex;
    if (!data.skills || !Array.isArray(data.skills)) {
      console.warn("[clawhub] Invalid registry format");
      return cachedRegistry;
    }

    cachedRegistry = data;
    cacheTimestamp = Date.now();
    return data;
  } catch (err) {
    console.warn(`[clawhub] Registry fetch error: ${String(err)}`);
    return cachedRegistry;
  }
}

/**
 * Search the registry by query string.
 * Matches against name, description, tags, and domains.
 */
export async function searchRegistry(
  query: string,
  registryUrl?: string,
): Promise<RegistryEntry[]> {
  const registry = await fetchRegistry(registryUrl);
  if (!registry) return [];

  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter((t) => t.length >= 2);

  return registry.skills
    .map((skill) => {
      const searchable = [
        skill.name,
        skill.description,
        ...(skill.tags ?? []),
        ...(skill.domains ?? []),
        skill.author,
      ]
        .join(" ")
        .toLowerCase();

      const matchCount = terms.filter((t) => searchable.includes(t)).length;
      return { skill, matchCount };
    })
    .filter((r) => r.matchCount > 0)
    .sort((a, b) => {
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      return (b.skill.downloads ?? 0) - (a.skill.downloads ?? 0);
    })
    .map((r) => r.skill);
}

/**
 * Install a skill from the registry by downloading its SKILL.md file.
 * Saves to the managed skills directory.
 */
export async function installFromRegistry(
  skillId: string,
  managedSkillsDir: string,
  registryUrl?: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const registry = await fetchRegistry(registryUrl);
  if (!registry) {
    return { success: false, error: "Could not fetch registry" };
  }

  const entry = registry.skills.find(
    (s) => s.id === skillId || s.name.toLowerCase() === skillId.toLowerCase(),
  );
  if (!entry) {
    return { success: false, error: `Skill "${skillId}" not found in registry` };
  }

  try {
    const res = await fetch(entry.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { success: false, error: `Failed to download skill: HTTP ${res.status}` };
    }

    const content = await res.text();
    if (!content || content.length < 10) {
      return { success: false, error: "Downloaded skill content is empty" };
    }

    // Write to managed skills directory
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const skillDir = join(managedSkillsDir, entry.id);
    mkdirSync(skillDir, { recursive: true });

    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, content, "utf-8");

    return { success: true, path: skillPath };
  } catch (err) {
    return { success: false, error: `Install failed: ${String(err)}` };
  }
}

/**
 * List all available skills from the registry.
 */
export async function listRegistry(
  registryUrl?: string,
): Promise<RegistryEntry[]> {
  const registry = await fetchRegistry(registryUrl);
  if (!registry) return [];
  return registry.skills;
}
