#!/usr/bin/env node
/**
 * Claude Gateway -> OpenClaw Migration Script
 *
 * Migrates preset YAML files, passkey credentials, and reports session history
 * from the standalone Claude Gateway (Python/FastAPI) to the OpenClaw plugin.
 *
 * Usage (standalone):
 *   node --import tsx extensions/claude-gateway/src/migrate.ts \
 *     --source /path/to/ClaudeGateway \
 *     --target ~/.openclaw
 *
 * Usage (via OpenClaw CLI):
 *   openclaw gateway:migrate --source /path/to/ClaudeGateway
 *
 * Idempotent: safe to run multiple times. Existing files are overwritten only
 * if the source is newer or the content differs. Directories are created as needed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MigrateOptions = {
  sourceDir: string;
  targetDir: string;
  dryRun: boolean;
  quiet: boolean;
};

type MigrateResult = {
  presetsCopied: number;
  presetsSkipped: number;
  passkeysStatus: "copied" | "skipped_identical" | "not_found" | "invalid" | "error";
  sessionSummary: SessionSummary | null;
  validationErrors: string[];
};

type SessionSummary = {
  totalSessions: number;
  byStatus: Record<string, number>;
  lastTen: Array<{ id: string; status: string; preset: string; createdAt: string }>;
};

type PasskeyEntry = {
  id: string;
  public_key: string;
  sign_count?: number;
  name?: string;
  registered_at?: number;
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function createLogger(quiet: boolean) {
  return {
    info: (msg: string) => {
      if (!quiet) console.log(`[migrate] ${msg}`);
    },
    warn: (msg: string) => console.warn(`[migrate] WARN: ${msg}`),
    error: (msg: string) => console.error(`[migrate] ERROR: ${msg}`),
    success: (msg: string) => {
      if (!quiet) console.log(`[migrate] OK: ${msg}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Preset Migration
// ---------------------------------------------------------------------------

function migratePresets(
  sourcePresetsDir: string,
  targetPresetsDir: string,
  dryRun: boolean,
  log: ReturnType<typeof createLogger>,
): { copied: number; skipped: number } {
  let copied = 0;
  let skipped = 0;

  if (!fs.existsSync(sourcePresetsDir)) {
    log.warn(`Source presets directory not found: ${sourcePresetsDir}`);
    return { copied, skipped };
  }

  const ymlFiles = fs
    .readdirSync(sourcePresetsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  if (ymlFiles.length === 0) {
    log.warn("No YAML preset files found in source directory");
    return { copied, skipped };
  }

  log.info(`Found ${ymlFiles.length} preset files in ${sourcePresetsDir}`);

  if (!dryRun) {
    fs.mkdirSync(targetPresetsDir, { recursive: true });
  }

  for (const file of ymlFiles) {
    const srcPath = path.join(sourcePresetsDir, file);
    const dstPath = path.join(targetPresetsDir, file);

    const srcContent = fs.readFileSync(srcPath, "utf-8");

    // Skip if target already exists with identical content
    if (fs.existsSync(dstPath)) {
      const dstContent = fs.readFileSync(dstPath, "utf-8");
      if (srcContent === dstContent) {
        log.info(`  ${file} — identical, skipping`);
        skipped++;
        continue;
      }
    }

    if (dryRun) {
      log.info(`  ${file} — would copy`);
      copied++;
    } else {
      fs.writeFileSync(dstPath, srcContent, "utf-8");
      log.success(`  ${file} — copied`);
      copied++;
    }
  }

  return { copied, skipped };
}

// ---------------------------------------------------------------------------
// Passkey Migration
// ---------------------------------------------------------------------------

function migratePasskeys(
  sourceDataDir: string,
  targetWebauthnDir: string,
  dryRun: boolean,
  log: ReturnType<typeof createLogger>,
): MigrateResult["passkeysStatus"] {
  const srcPath = path.join(sourceDataDir, "passkeys.json");

  if (!fs.existsSync(srcPath)) {
    log.warn(`Passkeys file not found: ${srcPath}`);
    log.info("  This is expected if running locally — passkeys are in the Docker volume on the server");
    return "not_found";
  }

  let srcContent: string;
  try {
    srcContent = fs.readFileSync(srcPath, "utf-8");
  } catch (err) {
    log.error(`Failed to read passkeys file: ${err}`);
    return "error";
  }

  // Validate JSON structure
  let parsed: unknown;
  try {
    parsed = JSON.parse(srcContent);
  } catch {
    log.error("Passkeys file is not valid JSON");
    return "invalid";
  }

  if (!Array.isArray(parsed)) {
    log.error(`Passkeys file root is ${typeof parsed}, expected array`);
    return "invalid";
  }

  // Validate each entry has required fields
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown>;
    if (typeof entry !== "object" || entry === null) {
      log.error(`Passkey entry at index ${i} is not an object`);
      return "invalid";
    }
    if (typeof entry.id !== "string" || typeof entry.public_key !== "string") {
      log.error(`Passkey entry at index ${i} missing required 'id' or 'public_key' string fields`);
      return "invalid";
    }
  }

  log.info(`Validated ${parsed.length} passkey credential(s)`);

  const dstPath = path.join(targetWebauthnDir, "passkeys.json");

  // Check if identical
  if (fs.existsSync(dstPath)) {
    const dstContent = fs.readFileSync(dstPath, "utf-8");
    if (srcContent === dstContent) {
      log.info("  Passkeys file identical, skipping");
      return "skipped_identical";
    }
  }

  if (dryRun) {
    log.info(`  Would copy ${parsed.length} passkey(s) to ${dstPath}`);
    return "copied";
  }

  fs.mkdirSync(targetWebauthnDir, { recursive: true });
  fs.writeFileSync(dstPath, srcContent, "utf-8");
  log.success(`Copied ${parsed.length} passkey credential(s) to ${dstPath}`);
  return "copied";
}

// ---------------------------------------------------------------------------
// Session History (informational only)
// ---------------------------------------------------------------------------

function readSessionHistory(
  sourceDataDir: string,
  log: ReturnType<typeof createLogger>,
): SessionSummary | null {
  const dbPath = path.join(sourceDataDir, "gateway.db");

  if (!fs.existsSync(dbPath)) {
    log.warn(`SQLite database not found: ${dbPath}`);
    log.info("  This is expected if running locally — the database is in the Docker volume on the server");
    return null;
  }

  // Attempt to use better-sqlite3 if available, otherwise report file existence
  try {
    // Dynamic import to avoid hard dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });

    try {
      // Get total count
      const countRow = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as {
        cnt: number;
      };

      // Get count by status
      const statusRows = db
        .prepare("SELECT status, COUNT(*) as cnt FROM sessions GROUP BY status ORDER BY cnt DESC")
        .all() as Array<{ status: string; cnt: number }>;

      const byStatus: Record<string, number> = {};
      for (const row of statusRows) {
        byStatus[row.status] = row.cnt;
      }

      // Get last 10 sessions
      const recentRows = db
        .prepare(
          "SELECT id, status, preset_name, created_at FROM sessions ORDER BY created_at DESC LIMIT 10",
        )
        .all() as Array<{
        id: string;
        status: string;
        preset_name: string;
        created_at: string;
      }>;

      const lastTen = recentRows.map((row) => ({
        id: row.id,
        status: row.status,
        preset: row.preset_name ?? "(unknown)",
        createdAt: row.created_at,
      }));

      db.close();

      const summary: SessionSummary = {
        totalSessions: countRow.cnt,
        byStatus,
        lastTen,
      };

      return summary;
    } catch (queryErr) {
      db.close();
      log.error(`Failed to query sessions: ${queryErr}`);
      return null;
    }
  } catch {
    // better-sqlite3 not available — report file stats only
    const stat = fs.statSync(dbPath);
    log.info(`SQLite database found: ${dbPath} (${(stat.size / 1024).toFixed(1)} KB)`);
    log.info("  Install 'better-sqlite3' to see session history details");
    log.info("  Sessions are informational only — they cannot be migrated (process handles)");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateMigration(
  targetPresetsDir: string,
  targetWebauthnDir: string,
  log: ReturnType<typeof createLogger>,
): string[] {
  const errors: string[] = [];

  // Validate presets load correctly
  if (fs.existsSync(targetPresetsDir)) {
    const ymlFiles = fs
      .readdirSync(targetPresetsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

    // Lazy-load js-yaml if available
    let yamlParse: ((content: string) => unknown) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require("js-yaml");
      yamlParse = (content: string) => yaml.load(content);
    } catch {
      // Try a basic YAML structure check — just verify it's not empty and has key fields
      yamlParse = undefined;
    }

    for (const file of ymlFiles) {
      const filePath = path.join(targetPresetsDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.trim().length === 0) {
          errors.push(`Preset ${file} is empty`);
          continue;
        }

        if (yamlParse) {
          const data = yamlParse(content) as Record<string, unknown>;
          if (!data || typeof data !== "object") {
            errors.push(`Preset ${file} did not parse as a YAML object`);
            continue;
          }
          if (typeof data.name !== "string" || data.name.length === 0) {
            errors.push(`Preset ${file} missing required 'name' field`);
          }
          if (typeof data.system_prompt !== "string" || data.system_prompt.length === 0) {
            errors.push(`Preset ${file} missing required 'system_prompt' field`);
          }
        } else {
          // Basic check without YAML parser
          if (!content.includes("name:")) {
            errors.push(`Preset ${file} appears to be missing 'name:' field`);
          }
          if (!content.includes("system_prompt:")) {
            errors.push(`Preset ${file} appears to be missing 'system_prompt:' field`);
          }
        }
      } catch (err) {
        errors.push(`Preset ${file} failed to read: ${err}`);
      }
    }

    log.info(`Validated ${ymlFiles.length} preset file(s) — ${errors.length} error(s)`);
  } else {
    errors.push(`Target presets directory does not exist: ${targetPresetsDir}`);
  }

  // Validate passkeys if present
  const passkeysPath = path.join(targetWebauthnDir, "passkeys.json");
  if (fs.existsSync(passkeysPath)) {
    try {
      const content = fs.readFileSync(passkeysPath, "utf-8");
      const data = JSON.parse(content);
      if (!Array.isArray(data)) {
        errors.push(`Passkeys file is not a JSON array`);
      } else {
        for (let i = 0; i < data.length; i++) {
          const entry = data[i];
          if (typeof entry !== "object" || entry === null) {
            errors.push(`Passkey entry ${i} is not an object`);
          } else if (typeof entry.id !== "string" || typeof entry.public_key !== "string") {
            errors.push(`Passkey entry ${i} missing required 'id' or 'public_key'`);
          }
        }
        log.info(`Validated ${data.length} passkey credential(s)`);
      }
    } catch (err) {
      errors.push(`Passkeys validation failed: ${err}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main Migration
// ---------------------------------------------------------------------------

export async function runMigration(opts: MigrateOptions): Promise<MigrateResult> {
  const log = createLogger(opts.quiet);
  const sourceDir = path.resolve(opts.sourceDir);
  const targetDir = path.resolve(opts.targetDir);

  log.info("=".repeat(60));
  log.info("Claude Gateway -> OpenClaw Migration");
  log.info("=".repeat(60));
  log.info(`Source: ${sourceDir}`);
  log.info(`Target: ${targetDir}`);
  if (opts.dryRun) log.info("DRY RUN — no files will be modified");
  log.info("");

  if (!fs.existsSync(sourceDir)) {
    log.error(`Source directory does not exist: ${sourceDir}`);
    return {
      presetsCopied: 0,
      presetsSkipped: 0,
      passkeysStatus: "error",
      sessionSummary: null,
      validationErrors: [`Source directory not found: ${sourceDir}`],
    };
  }

  // Paths
  const sourcePresetsDir = path.join(sourceDir, "presets");
  const sourceDataDir = path.join(sourceDir, "data");
  const targetPresetsDir = path.join(targetDir, "presets");
  const targetWebauthnDir = path.join(targetDir, "webauthn");

  // Step 1: Copy presets
  log.info("--- Step 1: Preset YAML files ---");
  const { copied: presetsCopied, skipped: presetsSkipped } = migratePresets(
    sourcePresetsDir,
    targetPresetsDir,
    opts.dryRun,
    log,
  );
  log.info(`  Copied: ${presetsCopied}, Skipped (identical): ${presetsSkipped}`);
  log.info("");

  // Step 2: Copy passkeys
  log.info("--- Step 2: Passkey credentials ---");
  const passkeysStatus = migratePasskeys(sourceDataDir, targetWebauthnDir, opts.dryRun, log);
  log.info("");

  // Step 3: Session history (informational)
  log.info("--- Step 3: Session history (informational) ---");
  const sessionSummary = readSessionHistory(sourceDataDir, log);
  if (sessionSummary) {
    log.info(`  Total sessions: ${sessionSummary.totalSessions}`);
    log.info("  By status:");
    for (const [status, count] of Object.entries(sessionSummary.byStatus)) {
      log.info(`    ${status}: ${count}`);
    }
    if (sessionSummary.lastTen.length > 0) {
      log.info("  Last 10 sessions:");
      for (const s of sessionSummary.lastTen) {
        log.info(`    ${s.createdAt} | ${s.status.padEnd(10)} | ${s.preset} (${s.id.slice(0, 8)}...)`);
      }
    }
    log.info("  NOTE: Sessions are not imported — they reference CLI process handles that cannot be migrated");
  } else {
    log.info("  No session data available (database not found or not readable)");
  }
  log.info("");

  // Step 4: Validate
  log.info("--- Step 4: Validation ---");
  const validationErrors = opts.dryRun
    ? [] // Skip validation on dry run since files weren't actually written
    : validateMigration(targetPresetsDir, targetWebauthnDir, log);

  if (validationErrors.length > 0) {
    log.error("Validation errors:");
    for (const err of validationErrors) {
      log.error(`  - ${err}`);
    }
  } else {
    log.success("All validation checks passed");
  }
  log.info("");

  // Summary
  log.info("=".repeat(60));
  log.info("Migration Summary");
  log.info("=".repeat(60));
  log.info(`Presets copied:    ${presetsCopied}`);
  log.info(`Presets skipped:   ${presetsSkipped}`);
  log.info(`Passkeys:          ${passkeysStatus}`);
  log.info(`Sessions:          ${sessionSummary ? `${sessionSummary.totalSessions} found (not imported)` : "N/A"}`);
  log.info(`Validation errors: ${validationErrors.length}`);

  if (opts.dryRun) {
    log.info("");
    log.info("Re-run without --dry-run to perform the migration.");
  }

  return {
    presetsCopied,
    presetsSkipped,
    passkeysStatus,
    sessionSummary,
    validationErrors,
  };
}

// ---------------------------------------------------------------------------
// CLI Registration (for OpenClaw plugin system)
// ---------------------------------------------------------------------------

export function registerMigrateCli(program: import("commander").Command): void {
  const migrate = program
    .command("gateway:migrate")
    .description("Migrate data from standalone Claude Gateway to OpenClaw gateway plugin")
    .option(
      "-s, --source <path>",
      "Path to the Claude Gateway source directory",
      process.platform === "win32" ? "D:/Projects/ClaudeGateway" : `${os.homedir()}/claude-gateway`,
    )
    .option(
      "-t, --target <path>",
      "Path to the OpenClaw state directory",
      path.join(os.homedir(), ".openclaw"),
    )
    .option("--dry-run", "Show what would be migrated without making changes", false)
    .option("-q, --quiet", "Suppress informational output", false)
    .action(async (cmdOpts: { source: string; target: string; dryRun: boolean; quiet: boolean }) => {
      const result = await runMigration({
        sourceDir: cmdOpts.source,
        targetDir: cmdOpts.target,
        dryRun: cmdOpts.dryRun,
        quiet: cmdOpts.quiet,
      });

      if (result.validationErrors.length > 0) {
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// Standalone Execution
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isMain) {
  const { values } = parseArgs({
    options: {
      source: { type: "string", short: "s" },
      target: { type: "string", short: "t" },
      "dry-run": { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const defaultSource =
    process.platform === "win32" ? "D:/Projects/ClaudeGateway" : `${os.homedir()}/claude-gateway`;

  runMigration({
    sourceDir: (values.source as string) ?? defaultSource,
    targetDir: (values.target as string) ?? path.join(os.homedir(), ".openclaw"),
    dryRun: (values["dry-run"] as boolean) ?? false,
    quiet: (values.quiet as boolean) ?? false,
  }).then((result) => {
    if (result.validationErrors.length > 0) {
      process.exitCode = 1;
    }
  });
}
