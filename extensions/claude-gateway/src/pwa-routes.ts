/**
 * HTTP handler serving the Claude Gateway PWA static files.
 *
 * Serves files from the `pwa/` directory under the `/gateway/ui/` URL prefix.
 * Applies security headers matching the original Gateway's SecurityHeadersMiddleware.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";

const UI_PREFIX = "/gateway/ui";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// CSP: Allow self + CDN for scripts/styles/fonts + wss: for WebSocket
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
  "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
  "font-src 'self' https://cdn.jsdelivr.net",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data: blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}

export function createPwaHttpHandler(pwaDir: string) {
  const resolvedPwaDir = path.resolve(pwaDir);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Only handle our prefix
    if (!pathname.startsWith(UI_PREFIX)) {
      return false;
    }

    // Only allow GET/HEAD
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return true;
    }

    // Strip prefix to get the file path
    let filePath = pathname.slice(UI_PREFIX.length);

    // Serve index.html for root path or empty path
    if (filePath === "" || filePath === "/") {
      filePath = "/index.html";
    }

    // Prevent directory traversal
    const normalized = path.normalize(filePath).replace(/\\/g, "/");
    if (normalized.includes("..")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return true;
    }

    const absolutePath = path.join(resolvedPwaDir, normalized);

    // Ensure the resolved path is still within pwaDir
    if (!absolutePath.startsWith(resolvedPwaDir)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return true;
    }

    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        // For SPA routing, serve index.html for non-file paths
        const indexPath = path.join(resolvedPwaDir, "index.html");
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath);
          setSecurityHeaders(res);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": content.length,
          });
          if (method === "HEAD") {
            res.end();
          } else {
            res.end(content);
          }
          return true;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return true;
      }

      const ext = path.extname(absolutePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      const content = fs.readFileSync(absolutePath);
      setSecurityHeaders(res);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(content);
      }
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // SPA fallback: serve index.html for unknown paths
        const indexPath = path.join(resolvedPwaDir, "index.html");
        try {
          const content = fs.readFileSync(indexPath);
          setSecurityHeaders(res);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": content.length,
          });
          if (method === "HEAD") {
            res.end();
          } else {
            res.end(content);
          }
          return true;
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return true;
        }
      }

      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return true;
    }
  };
}
