import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PasskeyStore, type PasskeyCredential } from "../src/passkey-store.js";

describe("PasskeyStore", () => {
  let tmpDir: string;
  let storePath: string;

  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  function makeCred(id: string, name: string): PasskeyCredential {
    return {
      id,
      public_key: `pk-${id}`,
      sign_count: 0,
      name,
      registered_at: Date.now(),
    };
  }

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-passkey-store-"));
    storePath = path.join(tmpDir, "passkeys.json");
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("creates empty store file if none exists", () => {
    expect(fs.existsSync(storePath)).toBe(false);

    const store = new PasskeyStore(storePath, silentLogger);
    store.add(makeCred("cred-1", "My Key"));

    // After add, file is created via save()
    expect(fs.existsSync(storePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
  });

  it("adds credential — list returns it", () => {
    const store = new PasskeyStore(storePath, silentLogger);
    const cred = makeCred("abc123", "Laptop Key");
    store.add(cred);

    const all = store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("abc123");
    expect(all[0].name).toBe("Laptop Key");
    expect(all[0].public_key).toBe("pk-abc123");
  });

  it("finds credential by ID", () => {
    const store = new PasskeyStore(storePath, silentLogger);
    store.add(makeCred("key-a", "Key A"));
    store.add(makeCred("key-b", "Key B"));

    const found = store.findById("key-b");
    expect(found).toBeDefined();
    expect(found!.id).toBe("key-b");
    expect(found!.name).toBe("Key B");
  });

  it("returns undefined for unknown ID", () => {
    const store = new PasskeyStore(storePath, silentLogger);
    store.add(makeCred("exists", "Exists"));

    const found = store.findById("does-not-exist");
    expect(found).toBeUndefined();
  });

  it("persists across instances", () => {
    const store1 = new PasskeyStore(storePath, silentLogger);
    store1.add(makeCred("persist-1", "First Key"));
    store1.add(makeCred("persist-2", "Second Key"));

    // Create a new instance pointing to the same file
    const store2 = new PasskeyStore(storePath, silentLogger);
    const all = store2.listAll();

    expect(all).toHaveLength(2);
    expect(store2.findById("persist-1")).toBeDefined();
    expect(store2.findById("persist-2")).toBeDefined();
    expect(store2.findById("persist-1")!.name).toBe("First Key");
  });

  it("hasCredentials property", () => {
    const store = new PasskeyStore(storePath, silentLogger);
    expect(store.hasCredentials).toBe(false);

    store.add(makeCred("cred-x", "X Key"));
    expect(store.hasCredentials).toBe(true);
  });

  it("atomic write safety — uses temp file pattern", () => {
    const store = new PasskeyStore(storePath, silentLogger);
    store.add(makeCred("atomic-1", "Atomic Test"));

    // Verify the final file exists and is valid JSON
    expect(fs.existsSync(storePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("atomic-1");

    // Verify no leftover .tmp files in the directory
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});
