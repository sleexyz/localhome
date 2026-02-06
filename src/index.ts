/**
 * TCP-level proxy for localhome
 * Handles WebSocket upgrades at the TCP level to avoid ECONNRESET issues
 */

import { buildMapping } from "./scan";
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

type SocketData = {
  buffer: Buffer;
  headersParsed: boolean;
  isUpgrade: boolean;
  backend: Socket<BackendData> | null;
  host: string | null;
  subdomain: string | null;
  targetPort: number | null;
  pendingWrite: Uint8Array | null; // data waiting for drain
  endAfterFlush: boolean; // close socket after pendingWrite is flushed
};

type BackendData = {
  client: Socket<SocketData>;
  rewriteHost?: string; // if set, rewrite Host header on first client chunk
};

function parseHttpHeaders(data: Buffer): {
  complete: boolean;
  method?: string;
  path?: string;
  headers?: Map<string, string>;
  headerEndIndex?: number;
} {
  const str = data.toString("utf8");
  const headerEnd = str.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return { complete: false };
  }

  const headerSection = str.slice(0, headerEnd);
  const lines = headerSection.split("\r\n");
  const [method, path] = lines[0].split(" ");

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).toLowerCase().trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      headers.set(key, value);
    }
  }

  return {
    complete: true,
    method,
    path,
    headers,
    headerEndIndex: headerEnd + 4
  };
}

function isWebSocketUpgrade(headers: Map<string, string>): boolean {
  const upgrade = headers.get("upgrade");
  const connection = headers.get("connection");
  return upgrade?.toLowerCase() === "websocket" &&
         (connection?.toLowerCase().includes("upgrade") ?? false);
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

/** Write data to socket with backpressure handling, then close. */
function writeAllAndEnd(socket: Socket<SocketData>, data: Uint8Array) {
  const written = socket.write(data);
  if (written < data.byteLength) {
    // Couldn't write everything — stash remainder for drain handler
    socket.data.pendingWrite = data.subarray(written);
    socket.data.endAfterFlush = true;
  } else {
    socket.end();
  }
}

const listener = Bun.listen<SocketData>({
  hostname: "0.0.0.0",
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
        // Rewrite Host header on the first chunk through a CONNECT tunnel
        // so backends (Vite etc.) don't reject the unfamiliar hostname
        if (socketData.backend.data.rewriteHost) {
          const newHost = socketData.backend.data.rewriteHost;
          socketData.backend.data.rewriteHost = undefined;
          const str = Buffer.isBuffer(data) ? data.toString("utf8") : new TextDecoder().decode(data);
          socketData.backend.write(str.replace(/^Host: .+$/m, `Host: ${newHost}`));
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
          const connectHost = path!.split(":")[0]; // "mux" from "mux:80"

          const mapping = await getMapping();
          const targetPort = mapping.get(connectHost);

          if (!targetPort || targetPort === listener.port) {
            // Unknown or self-referential — close so browser falls back to DIRECT
            socket.end();
            return;
          }

          socketData.subdomain = connectHost;
          socketData.targetPort = targetPort;
          console.log(`[tcp] CONNECT tunnel ${connectHost} -> :${targetPort}`);

          try {
            const backend = await Bun.connect<BackendData>({
              hostname: "localhost",
              port: targetPort,
              socket: {
                open(backendSocket) {
                  backendSocket.data = {
                    client: socket,
                    rewriteHost: `localhost:${targetPort}`,
                  };
                  // Tell client the tunnel is ready — browser sends real request next
                  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                },
                data(backendSocket, backendData) {
                  try {
                    backendSocket.data.client.write(backendData);
                  } catch (e) {
                    backendSocket.end();
                  }
                },
                close(backendSocket) {
                  try { backendSocket.data.client.end(); } catch (e) {}
                },
                error(backendSocket, error) {
                  console.log(`[tcp] CONNECT backend error for ${connectHost}: ${error.message}`);
                  try { backendSocket.data.client.end(); } catch (e) {}
                },
                end(backendSocket) {
                  try { backendSocket.data.client.end(); } catch (e) {}
                },
              },
            });

            socketData.backend = backend;
          } catch (e) {
            console.log(`[tcp] CONNECT failed for ${connectHost}: ${e}`);
            socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            socket.end();
          }
          return;
        }

        // Detect proxy-style request (browser sending absolute URI via PAC)
        let actualPath = path!;
        let proxyTarget: string | null = null;

        if (path!.startsWith("http://") || path!.startsWith("https://")) {
          const targetUrl = new URL(path!);
          proxyTarget = targetUrl.hostname;  // e.g. "mux"
          actualPath = targetUrl.pathname + targetUrl.search;  // e.g. "/somepath?q=1"
        }

        socketData.subdomain = proxyTarget ?? extractSubdomain(socketData.host);

        // Determine if this is a dashboard request
        let isDashboard = !socketData.subdomain;

        if (!isDashboard) {
          const mapping = await getMapping();
          socketData.targetPort = mapping.get(socketData.subdomain!) || null;
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
          socket.write(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNo server found for "${socketData.subdomain}.localhost"\n`);
          socket.end();
          return;
        }

        if (socketData.isUpgrade) {
          // WebSocket upgrade - do TCP-level proxying
          console.log(`[tcp] WebSocket upgrade ${socketData.subdomain} -> :${socketData.targetPort}`);

          // Rewrite request for backend: absolute URI → relative path, fix Host header
          if (proxyTarget) {
            let rawStr = socketData.buffer.toString("utf8");
            rawStr = rawStr.replace(
              `${method} ${path} `,
              `${method} ${actualPath} `
            );
            rawStr = rawStr.replace(
              /^Host: .+$/m,
              `Host: localhost:${socketData.targetPort}`
            );
            socketData.buffer = Buffer.from(rawStr);
          }

          try {
            const backend = await Bun.connect<BackendData>({
              hostname: "localhost",
              port: socketData.targetPort,
              socket: {
                open(backendSocket) {
                  backendSocket.data = { client: socket };
                  // Forward the original request including headers
                  backendSocket.write(socketData.buffer);
                },
                data(backendSocket, backendData) {
                  // Forward backend -> client
                  try {
                    backendSocket.data.client.write(backendData);
                  } catch (e) {
                    // Client disconnected
                    backendSocket.end();
                  }
                },
                close(backendSocket) {
                  console.log(`[tcp] Backend closed for ${socketData.subdomain}`);
                  try {
                    backendSocket.data.client.end();
                  } catch (e) {
                    // Already closed
                  }
                },
                error(backendSocket, error) {
                  console.log(`[tcp] Backend error for ${socketData.subdomain}: ${error.message}`);
                  try {
                    backendSocket.data.client.end();
                  } catch (e) {
                    // Already closed
                  }
                },
                end(backendSocket) {
                  try {
                    backendSocket.data.client.end();
                  } catch (e) {
                    // Already closed
                  }
                },
              },
            });

            socketData.backend = backend;
          } catch (e) {
            console.log(`[tcp] Failed to connect to backend: ${e}`);
            socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nFailed to connect to backend\n`);
            socket.end();
          }
        } else {
          // Regular HTTP - use fetch() for proxying
          const bodyStart = headerEndIndex!;
          const body = socketData.buffer.slice(bodyStart);

          // Reconstruct the URL
          const url = `http://localhost:${socketData.targetPort}${actualPath}`;

          // Build headers for fetch
          const fetchHeaders = new Headers();
          for (const [key, value] of headers!) {
            // Skip hop-by-hop headers
            if (!["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"].includes(key)) {
              fetchHeaders.set(key, value);
            }
          }
          // Strip conditional headers to avoid 304 loops
          fetchHeaders.delete("if-none-match");
          fetchHeaders.delete("if-modified-since");
          // Rewrite Host header for proxy requests so backends accept it
          if (proxyTarget) {
            fetchHeaders.set("host", `localhost:${socketData.targetPort}`);
          }

          try {
            const response = await fetch(url, {
              method: method,
              headers: fetchHeaders,
              body: method !== "GET" && method !== "HEAD" && body.length > 0 ? body : undefined,
              redirect: "manual",
            });

            // Build response headers
            let responseText = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
            for (const [key, value] of response.headers) {
              // Skip hop-by-hop headers and content-length (fetch decompresses
              // gzip/br bodies so the original content-length is wrong;
              // Connection: close signals end-of-body instead)
              if (!["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"].includes(key.toLowerCase())) {
                responseText += `${key}: ${value}\r\n`;
              }
            }
            responseText += "Connection: close\r\n\r\n";

            // Combine headers + body into one buffer so writeAllAndEnd
            // can handle backpressure for the entire response
            const headerBytes = new TextEncoder().encode(responseText);
            const bodyBytes = new Uint8Array(await response.arrayBuffer());
            const fullResp = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
            fullResp.set(headerBytes, 0);
            fullResp.set(bodyBytes, headerBytes.byteLength);
            writeAllAndEnd(socket, fullResp);
          } catch (e) {
            socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProxy error: ${e}\n`);
            socket.end();
          }
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
        } catch (e) {
          // Already closed
        }
      }
    },

    error(socket, error) {
      const socketData = socket.data;
      console.log(`[tcp] Client error: ${error.message}`);
      if (socketData?.backend) {
        try {
          socketData.backend.end();
        } catch (e) {
          // Already closed
        }
      }
    },
  },
});

const actualPort = listener.port;
console.log(`LISTENING:${actualPort}`);
console.log(`localhome (tcp mode) listening on http://localhost:${actualPort}`);
console.log(`Dashboard: http://localhost:${actualPort}`);
console.log(`\nStart services with: NAME=myapp bun run server.ts`);
