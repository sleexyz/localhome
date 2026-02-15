/**
 * TCP-level proxy for localhome
 * Handles WebSocket upgrades at the TCP level to avoid ECONNRESET issues
 */

import { buildMapping } from "./scan";
import {
  type SocketData,
  type BackendData,
  parseHttpHeaders,
  isWebSocketUpgrade,
  writeAllAndEnd,
  makeBackendSocketHandlers,
  proxyHttpRequest,
  proxyWebSocket,
} from "./proxy";
import type { Server, ServerWebSocket } from "bun";
import { loadCA, isMitmAvailable, getCert } from "./certs";
import type { Socket } from "bun";

const PORT = parseInt(process.env.PORT || "9090", 10);
const CACHE_TTL_MS = 5000;

let mappingCache: Map<string, number> = new Map();
let lastScan = 0;

async function getMapping(): Promise<Map<string, number>> {
  const now = Date.now();
  if (now - lastScan > CACHE_TTL_MS) {
    mappingCache = await buildMapping();
    lastScan = now;
  }
  return mappingCache;
}

function extractSubdomain(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(":")[0];
  if (hostname === "localhost") return null;
  if (!hostname.endsWith(".localhost")) return null;
  return hostname.slice(0, -".localhost".length) || null;
}

/** Validate Host header to prevent DNS rebinding attacks. */
function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0];
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "127.0.0.1" || hostname === "::1") return true;
  if (!hostname.includes(".")) return true; // bare hostnames from PAC
  return false;
}

// Dashboard HTML generator
async function renderDashboard(): Promise<string> {
  const { scanServers } = await import("./scan");
  const servers = await scanServers();

  let html = `HTTP/1.1 200 OK\r
Content-Type: text/html; charset=utf-8\r
Connection: close\r
\r
<!DOCTYPE html>
<html>
<head>
  <title>localhome</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #333; }
    .server { margin: 8px 0; }
    .server a { color: #0066cc; font-size: 1.1em; }
    .empty { color: #999; font-style: italic; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>localhome</h1>
`;

  if (servers.length === 0) {
    html += `
  <p class="empty">No services found.</p>
  <p>Start a server with: <code>NAME=myapp bun run server.ts</code></p>
`;
  } else {
    for (const server of servers) {
      html += `  <div class="server"><a href="http://${server.name}/">${server.name}/</a></div>\n`;
    }
  }

  html += `
</body>
</html>`;

  return html;
}

// ---- Internal TLS servers for HTTPS MITM (B4: Bun.serve per hostname) ----

const HOP_BY_HOP_TLS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
];

type TlsWsData = {
  hostname: string;
  targetPort: number;
  backendWs: WebSocket | null;
  backendReady: boolean;
  pendingMessages: (string | ArrayBuffer | Uint8Array)[];
};

const tlsServers = new Map<string, { port: number; server: Server }>();

async function getOrCreateTlsListener(
  hostname: string
): Promise<number | null> {
  const existing = tlsServers.get(hostname);
  if (existing) return existing.port;

  const certPair = getCert(hostname);
  if (!certPair) return null;

  const tlsServer = Bun.serve<TlsWsData>({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      cert: certPair.cert,
      key: certPair.key,
    },

    async fetch(req, server) {
      const url = new URL(req.url);

      // Look up backend port
      const mapping = await getMapping();
      const targetPort = mapping.get(hostname);

      // Self-referential or unknown — serve dashboard / PAC
      if (!targetPort || targetPort === listener.port) {
        if (!targetPort) {
          return new Response("Bad Gateway", { status: 502 });
        }
        if (url.pathname === "/proxy.pac") {
          const pac = `function FindProxyForURL(url, host) {\n  if (host.indexOf(".") === -1 && host !== "localhost") {\n    return "PROXY " + host + ".localhost:${listener.port}; DIRECT";\n  }\n  return "DIRECT";\n}\n`;
          return new Response(pac, {
            headers: {
              "content-type": "application/x-ns-proxy-autoconfig",
            },
          });
        }
        // Dashboard
        const { scanServers } = await import("./scan");
        const servers = await scanServers();
        let html = `<!DOCTYPE html>
<html>
<head>
  <title>localhome</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #333; }
    .server { margin: 8px 0; }
    .server a { color: #0066cc; font-size: 1.1em; }
    .empty { color: #999; font-style: italic; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>localhome</h1>
`;
        if (servers.length === 0) {
          html += `
  <p class="empty">No services found.</p>
  <p>Start a server with: <code>NAME=myapp bun run server.ts</code></p>
`;
        } else {
          for (const s of servers) {
            html += `  <div class="server"><a href="http://${s.name}/">${s.name}/</a></div>\n`;
          }
        }
        html += `\n</body>\n</html>`;
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // WebSocket upgrade
      if (
        req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        req.headers.get("connection")?.toLowerCase()?.includes("upgrade")
      ) {
        const upgraded = server.upgrade<TlsWsData>(req, {
          data: {
            hostname,
            targetPort,
            backendWs: null,
            backendReady: false,
            pendingMessages: [],
          },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // HTTP proxy via fetch()
      const backendUrl = `http://localhost:${targetPort}${url.pathname}${url.search}`;
      const fetchHeaders = new Headers();
      for (const [key, value] of req.headers) {
        if (!HOP_BY_HOP_TLS.includes(key.toLowerCase())) {
          fetchHeaders.set(key, value);
        }
      }
      // Strip conditional headers to avoid 304 loops
      fetchHeaders.delete("if-none-match");
      fetchHeaders.delete("if-modified-since");
      // Rewrite Host for backend
      fetchHeaders.set("host", `localhost:${targetPort}`);

      try {
        const resp = await fetch(backendUrl, {
          method: req.method,
          headers: fetchHeaders,
          body:
            req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          redirect: "manual",
        });

        // Build response, stripping content-encoding (fetch auto-decompresses)
        const respHeaders = new Headers();
        for (const [key, value] of resp.headers) {
          if (
            !["content-encoding", "transfer-encoding", "content-length"].includes(
              key.toLowerCase()
            )
          ) {
            respHeaders.set(key, value);
          }
        }

        return new Response(await resp.arrayBuffer(), {
          status: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
        });
      } catch (e) {
        return new Response(`Proxy error: ${e}`, { status: 502 });
      }
    },

    websocket: {
      open(ws) {
        const { targetPort } = ws.data;
        const backendUrl = `ws://localhost:${targetPort}/`;
        const backendWs = new WebSocket(backendUrl, {
          headers: {
            host: `localhost:${targetPort}`,
            origin: `http://localhost:${targetPort}`,
          },
        } as any);

        ws.data.backendWs = backendWs;

        backendWs.addEventListener("open", () => {
          ws.data.backendReady = true;
          // Flush any messages that arrived before backend was ready
          for (const msg of ws.data.pendingMessages) {
            backendWs.send(msg);
          }
          ws.data.pendingMessages = [];
        });

        backendWs.addEventListener("message", (ev) => {
          try {
            if (typeof ev.data === "string") {
              ws.sendText(ev.data);
            } else {
              ws.sendBinary(
                ev.data instanceof ArrayBuffer
                  ? new Uint8Array(ev.data)
                  : ev.data
              );
            }
          } catch {}
        });

        backendWs.addEventListener("close", () => {
          try {
            ws.close();
          } catch {}
        });
      },

      message(ws, message) {
        if (!ws.data.backendReady) {
          ws.data.pendingMessages.push(message);
          return;
        }
        const backendWs = ws.data.backendWs;
        if (backendWs) backendWs.send(message);
      },

      close(ws) {
        try {
          ws.data.backendWs?.close();
        } catch {}
      },
    },
  });

  const port = tlsServer.port;
  tlsServers.set(hostname, { port, server: tlsServer });
  console.log(`[tls] Created Bun.serve TLS for ${hostname} on port ${port}`);
  return port;
}

// ---- Main listener ----

// Load CA before starting (non-blocking — MITM just stays disabled if no CA)
await loadCA();

const listener = Bun.listen<SocketData>({
  hostname: process.env.BIND_HOST || "127.0.0.1",
  port: PORT,

  socket: {
    open(socket) {
      socket.data = {
        buffer: Buffer.alloc(0),
        headersParsed: false,
        isUpgrade: false,
        backend: null,
        host: null,
        subdomain: null,
        targetPort: null,
        pendingWrite: null,
        endAfterFlush: false,
      };
    },

    async data(socket, data) {
      const socketData = socket.data;

      // If we already have a backend connection, just forward data
      if (socketData.backend) {
        // Rewrite Host + Origin headers on the first chunk through a CONNECT tunnel
        // so backends (Vite, code-server, etc.) don't reject the unfamiliar hostname
        if (socketData.backend.data.rewriteHost) {
          const newHost = socketData.backend.data.rewriteHost;
          socketData.backend.data.rewriteHost = undefined;
          const str = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : new TextDecoder().decode(data);
          const rewritten = str
            .replace(/^Host: .+$/m, `Host: ${newHost}`)
            .replace(/^Origin: .+$/m, `Origin: http://${newHost}`);
          socketData.backend.write(rewritten);
          return;
        }
        socketData.backend.write(data);
        return;
      }

      // Accumulate data until we have complete headers
      socketData.buffer = Buffer.concat([socketData.buffer, data]);

      if (!socketData.headersParsed) {
        const parsed = parseHttpHeaders(socketData.buffer);
        if (!parsed.complete) {
          return; // Wait for more data
        }

        socketData.headersParsed = true;
        const { method, path, headers, headerEndIndex } = parsed;

        socketData.host = headers!.get("host") || null;
        socketData.isUpgrade = isWebSocketUpgrade(headers!);

        // Handle CONNECT tunnel (browsers use this for WebSocket/HTTPS through forward proxy)
        if (method === "CONNECT") {
          const [connectHost, connectPortStr] = path!.split(":");
          const connectPort = parseInt(connectPortStr || "80", 10);

          const mapping = await getMapping();
          const targetPort = mapping.get(connectHost);

          if (!targetPort) {
            socket.end();
            return;
          }

          // Self-referential: allow through for HTTPS MITM (TLS listener
          // serves dashboard), but close for HTTP (browser falls back to DIRECT)
          if (
            targetPort === listener.port &&
            !(connectPort === 443 && isMitmAvailable())
          ) {
            socket.end();
            return;
          }

          socketData.subdomain = connectHost;
          socketData.targetPort = targetPort;

          // HTTPS MITM: intercept TLS, decrypt, and proxy to plain HTTP backend
          if (connectPort === 443 && isMitmAvailable()) {
            console.log(
              `[tcp] CONNECT MITM ${connectHost}:443 -> :${targetPort}`
            );

            const tlsPort = await getOrCreateTlsListener(connectHost);
            if (!tlsPort) {
              socket.end();
              return;
            }

            try {
              const bridge = await Bun.connect<BackendData>({
                hostname: "127.0.0.1",
                port: tlsPort,
                socket: makeBackendSocketHandlers(socket, {
                  label: `MITM bridge ${connectHost}`,
                  onOpen() {
                    socket.write(
                      "HTTP/1.1 200 Connection Established\r\n\r\n"
                    );
                  },
                }),
              });

              socketData.backend = bridge;
            } catch (e) {
              console.log(
                `[tcp] MITM bridge failed for ${connectHost}: ${e}`
              );
              socket.write(
                "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"
              );
              socket.end();
            }
            return;
          }

          // Port 80 (or MITM not available) — raw TCP pipe to backend
          console.log(
            `[tcp] CONNECT tunnel ${connectHost} -> :${targetPort}`
          );

          try {
            const backend = await Bun.connect<BackendData>({
              hostname: "localhost",
              port: targetPort,
              socket: makeBackendSocketHandlers(socket, {
                rewriteHost: `localhost:${targetPort}`,
                onOpen() {
                  socket.write(
                    "HTTP/1.1 200 Connection Established\r\n\r\n"
                  );
                },
              }),
            });

            socketData.backend = backend;
          } catch (e) {
            console.log(`[tcp] CONNECT failed for ${connectHost}: ${e}`);
            socket.write(
              "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"
            );
            socket.end();
          }
          return;
        }

        // Host header validation (skip for CONNECT — no Host header)
        if (!isAllowedHost(socketData.host)) {
          socket.write(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: invalid Host header\n"
          );
          socket.end();
          return;
        }

        // Detect proxy-style request (browser sending absolute URI via PAC)
        let actualPath = path!;
        let proxyTarget: string | null = null;

        if (path!.startsWith("http://") || path!.startsWith("https://")) {
          const targetUrl = new URL(path!);
          proxyTarget = targetUrl.hostname; // e.g. "mux"
          actualPath = targetUrl.pathname + targetUrl.search; // e.g. "/somepath?q=1"
        }

        socketData.subdomain =
          proxyTarget ?? extractSubdomain(socketData.host);

        // Determine if this is a dashboard request
        let isDashboard = !socketData.subdomain;

        if (!isDashboard) {
          const mapping = await getMapping();
          socketData.targetPort =
            mapping.get(socketData.subdomain!) || null;
          // Self-referential: target resolves to our own port
          if (socketData.targetPort === listener.port) {
            isDashboard = true;
          }
        }

        if (isDashboard) {
          if (actualPath === "/proxy.pac") {
            const pac = `HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nConnection: close\r\n\r\nfunction FindProxyForURL(url, host) {\n  if (host.indexOf(".") === -1 && host !== "localhost") {\n    return "PROXY " + host + ".localhost:${listener.port}; DIRECT";\n  }\n  return "DIRECT";\n}\n`;
            socket.write(pac);
            socket.end();
            return;
          }
          const dashboard = await renderDashboard();
          socket.write(dashboard);
          socket.end();
          return;
        }

        if (!socketData.targetPort) {
          if (proxyTarget) {
            // Proxy request for unknown service — close without response
            // This triggers PAC's "; DIRECT" fallback in the browser
            socket.end();
            return;
          }
          socket.write(
            `HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNo server found for "${socketData.subdomain}.localhost"\n`
          );
          socket.end();
          return;
        }

        // Redirect HTTP → HTTPS for forward proxy when MITM is available
        if (proxyTarget && isMitmAvailable() && !socketData.isUpgrade) {
          socket.write(
            `HTTP/1.1 302 Found\r\nLocation: https://${proxyTarget}${actualPath}\r\nConnection: close\r\n\r\n`
          );
          socket.end();
          return;
        }

        if (socketData.isUpgrade) {
          // WebSocket upgrade — rewrite Host + Origin for backend
          let rawStr = socketData.buffer.toString("utf8");
          if (proxyTarget) {
            rawStr = rawStr.replace(
              `${method} ${path} `,
              `${method} ${actualPath} `
            );
          }
          rawStr = rawStr.replace(
            /^Host: .+$/m,
            `Host: localhost:${socketData.targetPort}`
          );
          rawStr = rawStr.replace(
            /^Origin: .+$/m,
            `Origin: http://localhost:${socketData.targetPort}`
          );
          socketData.buffer = Buffer.from(rawStr);

          const backend = await proxyWebSocket(socket, {
            targetPort: socketData.targetPort,
            subdomain: socketData.subdomain!,
            rawBuffer: socketData.buffer,
          });
          if (backend) socketData.backend = backend;
        } else {
          // Regular HTTP — use fetch() for proxying
          const body = socketData.buffer.slice(headerEndIndex!);
          await proxyHttpRequest(socket, {
            method: method!,
            path: actualPath,
            targetPort: socketData.targetPort,
            headers: headers!,
            body,
            rewriteHost: !!proxyTarget,
          });
        }
      }
    },

    drain(socket) {
      const socketData = socket.data;
      if (socketData.pendingWrite) {
        const written = socket.write(socketData.pendingWrite);
        if (written < socketData.pendingWrite.byteLength) {
          socketData.pendingWrite = socketData.pendingWrite.subarray(written);
        } else {
          socketData.pendingWrite = null;
          if (socketData.endAfterFlush) socket.end();
        }
      }
    },

    close(socket) {
      const socketData = socket.data;
      if (socketData?.backend) {
        console.log(`[tcp] Client closed for ${socketData.subdomain}`);
        try {
          socketData.backend.end();
        } catch (e) {}
      }
    },

    error(socket, error) {
      const socketData = socket.data;
      console.log(`[tcp] Client error: ${error.message}`);
      if (socketData?.backend) {
        try {
          socketData.backend.end();
        } catch (e) {}
      }
    },
  },
});

const actualPort = listener.port;
console.log(`LISTENING:${actualPort}`);
console.log(`localhome (tcp mode) listening on http://localhost:${actualPort}`);
console.log(`Dashboard: http://localhost:${actualPort}`);
console.log(`\nStart services with: NAME=myapp bun run server.ts`);
