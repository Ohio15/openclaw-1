/**
 * Filesystem helpers for WebAuthn state: path resolution against the gateway
 * state dir, owner-only directories/files, and the setup-token file.
 *
 * The passkey store is the root of trust for device approval, so it must live
 * on persistent storage and must not be writable by anyone but the gateway
 * user (a writable store lets another principal add their own credential).
 * The setup token is a bearer secret for first registration, so it is handed
 * to the owner through an owner-only file instead of any log stream.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginLogger = OpenClawPluginApi["logger"];

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const SETUP_TOKEN_FILENAME = "setup-token";

/** Directory under the gateway state dir that holds all WebAuthn state. */
export function webauthnStateDir(stateDir: string): string {
  return join(stateDir, "webauthn");
}

export function setupTokenFilePath(stateDir: string): string {
  return join(webauthnStateDir(stateDir), SETUP_TOKEN_FILENAME);
}

/**
 * Resolve the configured passkeys path.
 *
 * - empty            -> {stateDir}/webauthn/passkeys.json
 * - `~/...`/absolute -> expanded by the host resolver, used as-is
 * - relative         -> resolved against stateDir (NOT the process cwd, which in
 *                       the container image is the ephemeral /app tree)
 */
export function resolvePasskeysPath(
  configured: string,
  stateDir: string,
  resolveUserPath: (input: string) => string,
): string {
  const trimmed = configured.trim();
  if (!trimmed) {
    return join(webauthnStateDir(stateDir), "passkeys.json");
  }
  if (trimmed.startsWith("~") || isAbsolute(trimmed)) {
    return resolveUserPath(trimmed);
  }
  return resolve(stateDir, trimmed);
}

/** True when `child` is strictly inside `parent` (lexical check). */
export function isWithinDir(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Create `dir` (and parents) with owner-only permissions. Directories that
 * already exist are only narrowed when `tighten` is set, because a custom
 * passkeysPath may point into a directory this plugin does not own.
 */
export function ensurePrivateDir(dir: string, opts: { tighten: boolean }): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (opts.tighten && process.platform !== "win32") {
    const mode = statSync(dir).mode & 0o777;
    if (mode !== PRIVATE_DIR_MODE) {
      chmodSync(dir, PRIVATE_DIR_MODE);
    }
  }
}

/** Throw if a new file cannot be created in `dir`. Leaves nothing behind. */
export function assertWritableDir(dir: string): void {
  const probe = join(dir, `.write-probe-${randomBytes(6).toString("hex")}`);
  const fd = openSync(probe, "wx", PRIVATE_FILE_MODE);
  closeSync(fd);
  unlinkSync(probe);
}

/**
 * Atomically replace `target` with `data`, mode 0600.
 *
 * The temp file is created exclusively (`wx`) with mode 0600 so the content is
 * never visible with wider permissions and a pre-planted symlink at the temp
 * path is not followed; rename then replaces the target (or a symlink at the
 * target) as a unit. Throws on failure — callers must not report success for
 * state that never reached disk.
 */
export function writePrivateFileAtomic(target: string, data: string): void {
  const dir = dirname(target);
  const tmpPath = join(dir, `.${basename(target)}-${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  let tmpCreated = false;
  try {
    fd = openSync(tmpPath, "wx", PRIVATE_FILE_MODE);
    tmpCreated = true;
    writeFileSync(fd, data, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      renameSync(tmpPath, target);
      tmpCreated = false;
    } catch (renameErr) {
      // Windows can refuse to rename over a file another handle has open; fall
      // back to an in-place write. POSIX rename failures are real errors.
      if (process.platform !== "win32") {
        throw renameErr;
      }
      writeFileSync(target, data, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
    }
    if (process.platform !== "win32") {
      chmodSync(target, PRIVATE_FILE_MODE);
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already failing; the original error is what matters
      }
    }
    if (tmpCreated) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup of the temp file
      }
    }
  }
}

/**
 * Narrow an existing file to 0600 (files written by earlier versions were
 * created with the process umask, typically 0644).
 */
export function tightenFileMode(path: string, logger: PluginLogger): void {
  if (process.platform === "win32") {
    return;
  }
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return;
    }
    throw err;
  }
  if (mode !== PRIVATE_FILE_MODE) {
    chmodSync(path, PRIVATE_FILE_MODE);
    logger.warn(
      `webauthn: ${path} had mode ${mode.toString(8).padStart(4, "0")} — narrowed to 0600`,
    );
  }
}

/** Write the setup token to its owner-only file under the state dir. */
export function writeSetupTokenFile(stateDir: string, token: string): string {
  const dir = webauthnStateDir(stateDir);
  ensurePrivateDir(dir, { tighten: true });
  const filePath = setupTokenFilePath(stateDir);
  writePrivateFileAtomic(filePath, `${token}\n`);
  return filePath;
}

/**
 * Remove the setup-token file once the token it holds is no longer valid
 * (registration completed, or the token was rotated via the admin endpoint).
 * Failure is logged, not thrown: the in-memory token is already cleared, so a
 * leftover file holds a dead token, not a usable one.
 */
export function removeSetupTokenFile(stateDir: string, logger: PluginLogger): void {
  const filePath = setupTokenFilePath(stateDir);
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      logger.warn(`webauthn: could not remove stale setup-token file ${filePath} — ${String(err)}`);
    }
  }
}
