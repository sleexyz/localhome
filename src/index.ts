/**
 * TCP-level proxy for localhome
 * Handles WebSocket upgrades at the TCP level to avoid ECONNRESET issues
 */

import {
  buildMapping,
  scanServers,
  scanUnregistered,
  type UnregisteredService,
} from "./scan";
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
let tailscaleHostname: string | null = process.env.TAILSCALE_HOSTNAME || null;

async function getMapping(): Promise<Map<string, number>> {
  const now = Date.now();
  if (now - lastScan > CACHE_TTL_MS) {
    mappingCache = await buildMapping();
    lastScan = now;
  }
  return mappingCache;
}

// Set LOCALHOME_PROBE=0 to skip the per-service title/favicon fetch (used in tests).
const PROBE = process.env.LOCALHOME_PROBE !== "0";
let unregCache: UnregisteredService[] = [];
let unregLastScan = 0;

/** Cached unregistered-service scan (separate from the routing cache; dashboard-only). */
async function getUnregistered(): Promise<UnregisteredService[]> {
  const now = Date.now();
  if (now - unregLastScan > CACHE_TTL_MS) {
    unregCache = await scanUnregistered({ probe: PROBE });
    unregLastScan = now;
  }
  return unregCache;
}

/** Auto-detect tailscale machine name via CLI. */
async function detectTailscale(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const status = JSON.parse(output);
    // DNSName is like "seans-macbook-pro.tail84601.ts.net."
    const dnsName: string | undefined = status.Self?.DNSName;
    if (!dnsName) return null;
    return dnsName.split(".")[0] || null;
  } catch {
    return null;
  }
}

function extractSubdomain(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(":")[0];
  // *.localhost
  if (hostname === "localhost") return null;
  if (hostname.endsWith(".localhost")) {
    return hostname.slice(0, -".localhost".length) || null;
  }
  // *.{tailscaleHostname} (MagicDNS subdomain routing)
  if (tailscaleHostname) {
    if (hostname === tailscaleHostname) return null;
    const suffix = `.${tailscaleHostname}`;
    if (hostname.endsWith(suffix)) {
      return hostname.slice(0, -suffix.length) || null;
    }
  }
  return null;
}

/** Validate Host header to prevent DNS rebinding attacks. */
function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0];
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "127.0.0.1" || hostname === "::1") return true;
  if (!hostname.includes(".")) return true; // bare hostnames from PAC
  // MagicDNS: allow tailscale hostname and its subdomains
  if (tailscaleHostname) {
    if (hostname === tailscaleHostname) return true;
    if (hostname.endsWith(`.${tailscaleHostname}`)) return true;
  }
  return false;
}

/** Truncate the middle of a string, keeping both ends (the command tail is the useful part). */
function truncMiddle(s: string, max = 110): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.4);
  const tail = max - head - 1;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Escape text for safe interpolation into HTML. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

/** Turn `ps` elapsed time ("01-14:59:59", "26:42") into a short "up Xd/h/m". */
function formatUptime(etime: string): string {
  const t = etime.trim();
  if (!t) return "";
  let days = 0;
  let rest = t;
  if (t.includes("-")) {
    const [d, r] = t.split("-");
    days = parseInt(d, 10) || 0;
    rest = r;
  }
  const nums = rest.split(":").map((n) => parseInt(n, 10) || 0);
  let h = 0, m = 0, s = 0;
  if (nums.length === 3) [h, m, s] = nums;
  else if (nums.length === 2) [m, s] = nums;
  else [s] = nums;
  if (days > 0) return `up ${days}d`;
  if (h > 0) return `up ${h}h`;
  if (m > 0) return `up ${m}m`;
  return `up ${s}s`;
}

/** Render one unregistered service as an info card linking to its port(s). */
function renderUnregRow(s: UnregisteredService, home: string): string {
  const cwd =
    s.cwd && home && s.cwd.startsWith(home) ? `~${s.cwd.slice(home.length)}` : s.cwd;
  const cmd = truncMiddle(s.command, 110);
  // No NAME to route by, so link straight to the port on loopback.
  const href = (p: number) => `http://localhost:${p}/`;
  const ports = s.ports.map((p) => `<a href="${href(p)}">:${p}</a>`).join(", ");
  const icon = s.favicon
    ? `<img class="fav" src="${s.favicon}" alt="">`
    : `<span class="fav dot"></span>`;
  const titleText = s.title || s.process || "(unknown)";
  const badge =
    s.scope !== "local" ? ` <span class="badge ${s.scope}">${s.scope}</span>` : "";
  const up = s.etime ? ` <span class="up">${esc(formatUptime(s.etime))}</span>` : "";
  return `    <div class="unreg">
      <a class="fav-link" href="${href(s.primaryPort)}">${icon}</a>
      <div class="unreg-body">
        <div class="unreg-head"><a class="utitle" href="${href(s.primaryPort)}">${esc(titleText)}</a>${badge}${up}</div>
        ${cmd ? `<div class="cmd">${esc(cmd)}</div>` : ""}
        <div class="meta">${cwd ? `<span class="cwd">${esc(cwd)}</span> · ` : ""}<span class="ports">${ports}</span> · <span class="pid">pid ${s.pid}</span></div>
      </div>
    </div>\n`;
}

// Dashboard HTML generator — uses request Host to build service links
async function renderDashboardHtml(requestHost: string | null): Promise<string> {
  const [servers, unregistered] = await Promise.all([
    scanServers(),
    getUnregistered(),
  ]);
  const home = process.env.HOME || "";

  const parts = (requestHost || `localhost:${PORT}`).split(":");
  const baseName = parts[0];
  const port = parts[1] || String(PORT);

  let html = `<!DOCTYPE html>
<html>
<head>
  <title>localhome</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { color: #333; }
    h2 { color: #333; font-size: 1.15em; margin: 32px 0 8px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
    h3 { color: #888; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; margin: 18px 0 8px; }
    .server { margin: 8px 0; }
    .server a { color: #0066cc; font-size: 1.1em; }
    .empty { color: #999; font-style: italic; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 4px; }
    .unreg { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid #f0f0f0; align-items: flex-start; }
    .fav-link { flex: 0 0 16px; display: flex; justify-content: center; margin-top: 3px; line-height: 0; }
    .fav { width: 16px; height: 16px; border-radius: 3px; }
    .fav.dot { background: #ccc; border-radius: 50%; width: 8px; height: 8px; margin-top: 3px; }
    .unreg-body { min-width: 0; flex: 1; }
    .unreg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .utitle { font-weight: 600; color: #0066cc; text-decoration: none; }
    .utitle:hover { text-decoration: underline; }
    .cmd { font-family: ui-monospace, monospace; font-size: 0.8em; color: #555; word-break: break-all; margin: 2px 0; }
    .meta { font-size: 0.82em; color: #888; }
    .meta .cwd { color: #0a7d28; }
    .meta .ports { font-family: ui-monospace, monospace; }
    .meta .ports a { color: #0066cc; text-decoration: none; }
    .meta .ports a:hover { text-decoration: underline; }
    .badge { font-size: 0.68em; padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.03em; }
    .badge.exposed { background: #fde7e7; color: #b42318; }
    .badge.mixed { background: #fff3d6; color: #8a5a00; }
    .up { font-size: 0.78em; color: #aaa; }
    details.sys { margin-top: 8px; }
    details.sys summary { cursor: pointer; color: #888; font-size: 0.85em; }
    details.sys[open] summary { margin-bottom: 4px; }
    details.sys .unreg { opacity: 0.7; }
  </style>
</head>
<body>
  <h1>localhome</h1>

  <h2>Registered</h2>
`;

  if (servers.length === 0) {
    html += `  <p class="empty">No registered services. Start one with <code>NAME=myapp bun run server.ts</code></p>\n`;
  } else {
    for (const server of servers) {
      html += `  <div class="server"><a href="http://${server.name}.${baseName}:${port}/">${server.name}/</a></div>\n`;
    }
  }

  const dev = unregistered.filter((s) => s.isDev);
  const sys = unregistered.filter((s) => !s.isDev);

  html += `\n  <h2>Unregistered</h2>\n`;
  if (unregistered.length === 0) {
    html += `  <p class="empty">No other listening services found.</p>\n`;
  } else {
    if (dev.length > 0) {
      html += `  <h3>Likely dev servers</h3>\n`;
      for (const s of dev) html += renderUnregRow(s, home);
    } else {
      html += `  <p class="empty">No unregistered dev servers.</p>\n`;
    }
    if (sys.length > 0) {
      html += `  <details class="sys"><summary>System / other (${sys.length})</summary>\n`;
      for (const s of sys) html += renderUnregRow(s, home);
      html += `  </details>\n`;
    }
  }

  html += `</body>
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
  requestPath: string; // original path + query (e.g. "/?token=abc")
  protocols: string[]; // WebSocket subprotocols (e.g. ["vite-hmr"])
};

const tlsServers = new Map<string, { port: number; server: Server }>();

/** Drain a ReadableStream to completion, discarding data. Prevents RST on upstream connections. */
async function drainBody(body: ReadableStream | null) {
  if (!body) return;
  try {
    const reader = body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {}
}

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
        const dashHtml = await renderDashboardHtml(req.headers.get("host"));
        return new Response(dashHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // WebSocket upgrade
      if (
        req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        req.headers.get("connection")?.toLowerCase()?.includes("upgrade")
      ) {
        const protocols = (
          req.headers.get("sec-websocket-protocol") || ""
        )
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const upgraded = server.upgrade<TlsWsData>(req, {
          data: {
            hostname,
            targetPort,
            backendWs: null,
            backendReady: false,
            pendingMessages: [],
            requestPath: url.pathname + url.search,
            protocols,
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
      // Disable keep-alive to prevent RST on pooled connections
      fetchHeaders.set("connection", "close");

      try {
        const resp = await fetch(backendUrl, {
          method: req.method,
          headers: fetchHeaders,
          body:
            req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          redirect: "manual",
        });

        // Build response, stripping hop-by-hop and encoding headers
        const respHeaders = new Headers();
        for (const [key, value] of resp.headers) {
          const lk = key.toLowerCase();
          if (
            !["content-encoding", "transfer-encoding"].includes(lk) &&
            !HOP_BY_HOP_TLS.includes(lk)
          ) {
            respHeaders.set(key, value);
          }
        }

        // Stream the response body through to the client
        return new Response(resp.body, {
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
        const { targetPort, requestPath, protocols } = ws.data;
        const backendUrl = `ws://localhost:${targetPort}${requestPath}`;
        const backendWs = new WebSocket(
          backendUrl,
          {
            headers: {
              host: `localhost:${targetPort}`,
              origin: `http://localhost:${targetPort}`,
            },
            protocols: protocols.length > 0 ? protocols : undefined,
          } as any
        );

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

        backendWs.addEventListener("close", (ev) => {
          try {
            ws.close(ev.code, ev.reason);
          } catch {}
        });

        backendWs.addEventListener("error", () => {
          // Swallow errors on backend WS to prevent unhandled exceptions
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
        if (backendWs && backendWs.readyState === WebSocket.OPEN) {
          backendWs.send(message);
        }
      },

      close(ws) {
        const bws = ws.data.backendWs;
        if (!bws) return;
        try {
          if (bws.readyState === WebSocket.OPEN) {
            bws.close(1000, "client disconnected");
          } else if (bws.readyState === WebSocket.CONNECTING) {
            // Not open yet — close as soon as it opens
            bws.addEventListener("open", () => {
              bws.close(1000, "client disconnected");
            });
          }
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

// Detect tailscale machine name for MagicDNS subdomain routing
if (!tailscaleHostname) {
  tailscaleHostname = await detectTailscale();
}

// Load CA before starting (non-blocking — MITM just stays disabled if no CA)
await loadCA();

const listener = Bun.listen<SocketData>({
  hostname: process.env.BIND_HOST || (tailscaleHostname ? "0.0.0.0" : "127.0.0.1"),
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
          const dashHtml = await renderDashboardHtml(socketData.host);
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n${dashHtml}`);
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
          const hostBase = socketData.host?.split(":")[0] || "localhost";
          socket.write(
            `HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNo server found for "${socketData.subdomain}" (${hostBase})\n`
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
if (tailscaleHostname) {
  console.log(`Tailscale: http://${tailscaleHostname}:${actualPort} (MagicDNS)`);
  console.log(`  Services at: http://<name>.${tailscaleHostname}:${actualPort}`);
}
console.log(`\nStart services with: NAME=myapp bun run server.ts`);
