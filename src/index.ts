/**
 * localhostess daemon
 * Routes *.localhost:9999 to local services based on LOCALHOST_NAME env var
 */

import { buildMapping, scanServers } from "./scan";

const PORT = parseInt(process.env.PORT || "9999", 10);
const CACHE_TTL_MS = 5000; // Re-scan after 5 seconds

let mappingCache: Map<string, number> = new Map();
let lastScan = 0;

// Track backend WebSocket connections for each client
const wsBackends = new WeakMap<object, WebSocket>();

/**
 * Get current mapping, re-scanning if cache is stale
 */
async function getMapping(): Promise<Map<string, number>> {
  const now = Date.now();
  if (now - lastScan > CACHE_TTL_MS) {
    mappingCache = await buildMapping();
    lastScan = now;
  }
  return mappingCache;
}

/**
 * Extract subdomain from Host header
 * e.g., "paper.localhost:9999" -> "paper"
 */
function extractSubdomain(host: string | null): string | null {
  if (!host) return null;

  // Remove port
  const hostname = host.split(":")[0];

  // Check if it's a subdomain of localhost
  if (hostname === "localhost") return null;
  if (!hostname.endsWith(".localhost")) return null;

  // Extract subdomain (everything before .localhost)
  const subdomain = hostname.slice(0, -".localhost".length);
  return subdomain || null;
}

/**
 * Proxy request to target port
 */
async function proxyRequest(req: Request, targetPort: number): Promise<Response> {
  const url = new URL(req.url);
  url.hostname = "localhost";
  url.port = String(targetPort);

  try {
    // Clone headers and strip conditional request headers to avoid 304 loops
    const headers = new Headers(req.headers);
    headers.delete("If-None-Match");
    headers.delete("If-Modified-Since");

    const proxyReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    return await fetch(proxyReq);
  } catch (e) {
    return new Response(`Failed to proxy to port ${targetPort}: ${e}`, {
      status: 502,
    });
  }
}

/**
 * Render dashboard HTML
 */
async function renderDashboard(): Promise<Response> {
  const servers = await scanServers();

  let html = `<!DOCTYPE html>
<html>
<head>
  <title>localhostess</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #333; }
    .server { background: #f5f5f5; border-radius: 8px; padding: 16px; margin: 12px 0; }
    .server a { color: #0066cc; font-size: 1.2em; font-weight: bold; }
    .meta { color: #666; font-size: 0.9em; margin-top: 8px; }
    .empty { color: #999; font-style: italic; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>localhostess</h1>
  <p>Routing <code>*.localhost:${PORT}</code> to local services</p>
`;

  if (servers.length === 0) {
    html += `
  <p class="empty">No servers found with NAME env var.</p>
  <p>Start a server with:</p>
  <pre><code>NAME=myapp bun run server.ts</code></pre>
`;
  } else {
    html += `<h2>Active Services</h2>`;
    for (const server of servers) {
      html += `
  <div class="server">
    <a href="http://${server.name}.localhost:${PORT}">${server.name}.localhost:${PORT}</a>
    <span>→ :${server.port}</span>
    <div class="meta">PID ${server.pid} · ${server.command.slice(0, 60)}...</div>
  </div>
`;
    }
  }

  html += `
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Check if request is a WebSocket upgrade
 */
function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  return upgrade?.toLowerCase() === "websocket";
}

// Start server
console.log(`localhostess listening on http://localhost:${PORT}`);
console.log(`Dashboard: http://localhost:${PORT}`);
console.log(`\nStart services with: NAME=myapp bun run server.ts`);

const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const host = req.headers.get("host");
    const subdomain = extractSubdomain(host);

    // Dashboard at localhost:9999 or _.localhost:9999
    if (!subdomain || subdomain === "_") {
      return renderDashboard();
    }

    // Look up mapping
    const mapping = await getMapping();
    const targetPort = mapping.get(subdomain);

    if (!targetPort) {
      return new Response(`No server found for "${subdomain}.localhost"\n`, {
        status: 404,
      });
    }

    // Handle WebSocket upgrade
    if (isWebSocketUpgrade(req)) {
      const url = new URL(req.url);
      const backendUrl = `ws://localhost:${targetPort}${url.pathname}${url.search}`;
      console.log(`[ws] Upgrading ${subdomain} -> ${backendUrl}`);

      const upgraded = server.upgrade(req, {
        data: { backendUrl, subdomain },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined as unknown as Response;
    }

    return proxyRequest(req, targetPort);
  },

  websocket: {
    open(clientWs) {
      const { backendUrl, subdomain } = clientWs.data as { backendUrl: string; subdomain: string };
      console.log(`[ws] Client connected for ${subdomain}`);

      // Connect to backend WebSocket
      const backendWs = new WebSocket(backendUrl);

      wsBackends.set(clientWs, backendWs);

      backendWs.addEventListener("open", () => {
        console.log(`[ws] Backend connected for ${subdomain}`);
      });

      backendWs.addEventListener("message", (event) => {
        // Forward backend -> client
        try {
          if (typeof event.data === "string") {
            clientWs.send(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            clientWs.send(new Uint8Array(event.data));
          } else if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((buf) => {
              clientWs.send(new Uint8Array(buf));
            });
          }
        } catch (e) {
          console.log(`[ws] Error forwarding to client: ${e}`);
        }
      });

      backendWs.addEventListener("close", (event) => {
        console.log(`[ws] Backend closed for ${subdomain}: ${event.code}`);
        clientWs.close(event.code, event.reason);
      });

      backendWs.addEventListener("error", (event) => {
        console.log(`[ws] Backend error for ${subdomain}: ${event}`);
        clientWs.close(1011, "Backend error");
      });
    },

    message(clientWs, message) {
      const backendWs = wsBackends.get(clientWs);
      if (backendWs && backendWs.readyState === WebSocket.OPEN) {
        // Forward client -> backend
        backendWs.send(message);
      }
    },

    close(clientWs, code, reason) {
      const { subdomain } = clientWs.data as { subdomain: string };
      console.log(`[ws] Client closed for ${subdomain}: ${code}`);

      const backendWs = wsBackends.get(clientWs);
      if (backendWs) {
        backendWs.close(code, reason);
        wsBackends.delete(clientWs);
      }
    },
  },
});
