/**
 * ClawHub CLI — Command-line interface for community skill management.
 *
 * Commands:
 *   openclaw clawhub search <query>  — search the skill registry
 *   openclaw clawhub install <id>    — install a skill
 *   openclaw clawhub list            — list all available skills
 */

import type { Command } from "commander";
import {
  searchRegistry,
  installFromRegistry,
  listRegistry,
} from "../agents/skills/clawhub-registry.js";

export function registerClawHubCli(program: Command, managedSkillsDir: string): void {
  const clawhub = program
    .command("clawhub")
    .description("Community skill management via ClawHub");

  clawhub
    .command("search")
    .description("Search for community skills")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Maximum results to show", "20")
    .action(async (query: string, opts: { limit: string }) => {
      const limit = parseInt(opts.limit, 10) || 20;
      const results = await searchRegistry(query);

      if (results.length === 0) {
        console.log("No skills found matching your query.");
        return;
      }

      const display = results.slice(0, limit);
      console.log(`Found ${results.length} skills${results.length > limit ? ` (showing ${limit})` : ""}:\n`);

      for (const skill of display) {
        const tags = skill.tags?.length ? ` [${skill.tags.join(", ")}]` : "";
        const downloads = skill.downloads ? ` (${skill.downloads} downloads)` : "";
        console.log(`  ${skill.id} — ${skill.name}${downloads}`);
        console.log(`    ${skill.description}${tags}`);
        if (skill.domains?.length) {
          console.log(`    Domains: ${skill.domains.join(", ")}`);
        }
        console.log();
      }
    });

  clawhub
    .command("install")
    .description("Install a community skill")
    .argument("<id>", "Skill ID or name")
    .action(async (id: string) => {
      console.log(`Installing skill: ${id}...`);
      const result = await installFromRegistry(id, managedSkillsDir);

      if (result.success) {
        console.log(`Installed successfully: ${result.path}`);
      } else {
        console.error(`Installation failed: ${result.error}`);
        process.exitCode = 1;
      }
    });

  clawhub
    .command("list")
    .description("List all available community skills")
    .option("--limit <n>", "Maximum skills to show", "50")
    .action(async (opts: { limit: string }) => {
      const limit = parseInt(opts.limit, 10) || 50;
      const skills = await listRegistry();

      if (skills.length === 0) {
        console.log("No skills available (registry may be unreachable).");
        return;
      }

      console.log(`Available skills (${skills.length} total, showing ${Math.min(skills.length, limit)}):\n`);

      for (const skill of skills.slice(0, limit)) {
        const domains = skill.domains?.length ? ` [${skill.domains.join(", ")}]` : "";
        console.log(`  ${skill.id.padEnd(30)} ${skill.name}${domains}`);
      }
    });
}
