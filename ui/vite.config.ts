import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

/**
 * Replaces the __BUILD_HASH__ placeholder in sw.js with a unique hash so that
 * each build/deploy busts the service worker cache automatically.
 */
function swCacheBustPlugin(): Plugin {
  return {
    name: "openclaw-sw-cache-bust",
    apply: "build",
    closeBundle() {
      const outDir = path.resolve(here, "../dist/control-ui");
      const swPath = path.join(outDir, "sw.js");
      if (!fs.existsSync(swPath)) {
        return;
      }
      const content = fs.readFileSync(swPath, "utf-8");
      const buildHash = crypto.randomBytes(8).toString("hex");
      const updated = content.replace("__BUILD_HASH__", buildHash);
      fs.writeFileSync(swPath, updated, "utf-8");
    },
  };
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    plugins: [swCacheBustPlugin()],
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
  };
});
