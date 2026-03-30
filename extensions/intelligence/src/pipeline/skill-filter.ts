/**
 * Skill Filter — Complexity-aware skill filtering for the intelligence pipeline.
 *
 * Filters and prioritizes skills based on complexity analysis and domain detection.
 * Skills can declare optional metadata:
 *   openclaw.minComplexity: number (0-1) — minimum complexity to activate
 *   openclaw.domains: string[] — relevant domain keywords
 */

export interface SkillMetadata {
  id: string;
  name: string;
  description?: string;
  minComplexity?: number;
  domains?: string[];
}

export interface SkillFilterResult {
  relevant: SkillMetadata[];
  excluded: SkillMetadata[];
  contextGuidance: string | null;
}

/**
 * Filter skills by complexity analysis and domain.
 * Returns relevant skills and a context guidance string for prompt injection.
 */
export function filterSkillsByComplexity(
  skills: SkillMetadata[],
  analysis: {
    complexity: number;
    domain: string | null;
    taskType: string;
  },
): SkillFilterResult {
  const relevant: SkillMetadata[] = [];
  const excluded: SkillMetadata[] = [];

  for (const skill of skills) {
    // Check minimum complexity threshold
    if (skill.minComplexity !== undefined && analysis.complexity < skill.minComplexity) {
      excluded.push(skill);
      continue;
    }

    // Check domain overlap if skill declares domains
    if (skill.domains && skill.domains.length > 0 && analysis.domain) {
      const domainMatch = skill.domains.some(
        (d) => d.toLowerCase() === analysis.domain!.toLowerCase() ||
               analysis.domain!.toLowerCase().includes(d.toLowerCase()) ||
               d.toLowerCase().includes(analysis.domain!.toLowerCase())
      );
      if (domainMatch) {
        relevant.push(skill);
        continue;
      }
    }

    // If no domain filter or no domain detected, include by default
    if (!skill.domains || skill.domains.length === 0 || !analysis.domain) {
      relevant.push(skill);
    } else {
      excluded.push(skill);
    }
  }

  // Sort relevant skills: domain matches first, then by name
  relevant.sort((a, b) => {
    const aDomain = a.domains?.some(d => d.toLowerCase() === (analysis.domain ?? "").toLowerCase()) ? 0 : 1;
    const bDomain = b.domains?.some(d => d.toLowerCase() === (analysis.domain ?? "").toLowerCase()) ? 0 : 1;
    if (aDomain !== bDomain) return aDomain - bDomain;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });

  // Generate context guidance
  let contextGuidance: string | null = null;
  if (relevant.length > 0 && relevant.length <= 10) {
    const skillList = relevant
      .slice(0, 5)
      .map((s) => `- **${s.name || s.id}**: ${s.description || "No description"}`)
      .join("\n");
    contextGuidance = `## Available Skills\n\nThe following skills are most relevant to this request:\n${skillList}\n\nLeverage these skills when applicable.`;
  }

  return { relevant, excluded, contextGuidance };
}
