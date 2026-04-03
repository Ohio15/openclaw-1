import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPwaHttpHandler } from "../src/pwa-routes.js";

describe("PWA HTTP Handler", () => {
  let tmpDir: string;
  let handler: ReturnType<typeof createPwaHttpHandler>;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-pwa-test-"));

    // Create realistic PWA files
    fs.writeFileSync(path.join(tmpDir, "index.html"), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Claude Gateway</title></head>
<body><div id="app"></div><script src="app.js"></script></body>
</html>`, "utf-8");

    fs.writeFileSync(path.join(tmpDir, "styles.css"), `body { background: #0d1117; color: #c9d1d9; }
.chat { display: flex; flex-direction: column; }`, "utf-8");

    fs.writeFileSync(path.join(tmpDir, "app.js"), `(function() {
  const app = document.getElementById('app');
  app.textContent = 'Claude Gateway';
})();`, "utf-8");

    fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify({
      name: "Claude Gateway",
      short_name: "Gateway",
      start_url: "/gateway/ui/",
      display: "standalone",
      theme_color: "#0d1117",
      background_color: "#0d1117",
    }, null, 2), "utf-8");

    handler = createPwaHttpHandler(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  function mockReq(method: string, url: string): IncomingMessage {
    const readable = new Readable({ read() { this.push(null); } });
    Object.assign(readable, {
      method,
      url,
      headers: { host: "localhost:3000" },
      httpVersion: "1.1",
      httpVersionMajor: 1,
      httpVersionMinor: 1,
    });
    return readable as unknown as IncomingMessage;
  }

  function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: Buffer } {
    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let status = 200;
    const res = {
      _status: status,
      _headers: headers,
      get _body() {
        return Buffer.concat(chunks);
      },
      headersSent: false,
      writeHead(s: number, h?: Record<string, string | number>) {
        res._status = s;
        if (h) {
          for (const [k, v] of Object.entries(h)) {
            res._headers[k.toLowerCase()] = String(v);
          }
        }
        return res;
      },
      setHeader(k: string, v: string) {
        res._headers[k.toLowerCase()] = v;
        return res;
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        res.headersSent = true;
        return res;
      },
    };
    return res as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: Buffer };
  }

  it("PWA index.html served at /gateway/ui/", async () => {
    const req = mockReq("GET", "/gateway/ui/");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);

    const html = res._body.toString("utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<div id=\"app\">");
    expect(html).toContain("Claude Gateway");
  });

  it("CSS served with correct Content-Type", async () => {
    const req = mockReq("GET", "/gateway/ui/styles.css");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toContain("text/css");

    const css = res._body.toString("utf-8");
    expect(css).toContain("background");
  });

  it("JS served with correct Content-Type", async () => {
    const req = mockReq("GET", "/gateway/ui/app.js");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toContain("application/javascript");

    const js = res._body.toString("utf-8");
    expect(js).toContain("getElementById");
  });

  it("manifest.json served", async () => {
    const req = mockReq("GET", "/gateway/ui/manifest.json");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);

    const manifest = JSON.parse(res._body.toString("utf-8"));
    expect(manifest.name).toBe("Claude Gateway");
    expect(manifest.short_name).toBe("Gateway");
    expect(manifest.start_url).toBe("/gateway/ui/");
    expect(manifest.display).toBe("standalone");
  });

  it("CSP headers present", async () => {
    const req = mockReq("GET", "/gateway/ui/");
    const res = mockRes();
    await handler(req, res);

    expect(res._headers["content-security-policy"]).toBeDefined();
    const csp = res._headers["content-security-policy"];
    expect(csp).toContain("default-src");
    expect(csp).toContain("script-src");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("Cache-Control headers", async () => {
    const req = mockReq("GET", "/gateway/ui/");
    const res = mockRes();
    await handler(req, res);

    expect(res._headers["cache-control"]).toContain("no-cache");
    expect(res._headers["cache-control"]).toContain("must-revalidate");
  });

  it("non-existent file falls back to index.html (SPA routing)", async () => {
    // The PWA handler serves index.html for unknown paths as SPA fallback
    const req = mockReq("GET", "/gateway/ui/nonexistent.js");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    // SPA fallback returns 200 with index.html content
    expect(res._status).toBe(200);
    const body = res._body.toString("utf-8");
    expect(body).toContain("<!DOCTYPE html>");
  });
});
