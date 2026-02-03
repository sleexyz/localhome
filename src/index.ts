/**
 * TCP-level proxy for localhostess
 * Handles WebSocket upgrades at the TCP level to avoid ECONNRESET issues
 */

import { buildMapping } from "./scan";
import type { Socket } from "bun";

const PORT = parseInt(process.env.PORT || "9999", 10);
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
};

type BackendData = {
  client: Socket<SocketData>;
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
  <h1>localhostess (tcp mode)</h1>
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

  return html;
}

console.log(`localhostess (tcp mode) listening on http://localhost:${PORT}`);
console.log(`Dashboard: http://localhost:${PORT}`);
console.log(`\nStart services with: NAME=myapp bun run server.ts`);

Bun.listen<SocketData>({
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
      };
    },

    async data(socket, data) {
      const socketData = socket.data;

      // If we already have a backend connection, just forward data
      if (socketData.backend) {
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
        socketData.subdomain = extractSubdomain(socketData.host);
        socketData.isUpgrade = isWebSocketUpgrade(headers!);

        // Dashboard request
        if (!socketData.subdomain || socketData.subdomain === "_") {
          const dashboard = await renderDashboard();
          socket.write(dashboard);
          socket.end();
          return;
        }

        // Look up target port
        const mapping = await getMapping();
        socketData.targetPort = mapping.get(socketData.subdomain) || null;

        if (!socketData.targetPort) {
          socket.write(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNo server found for "${socketData.subdomain}.localhost"\n`);
          socket.end();
          return;
        }

        if (socketData.isUpgrade) {
          // WebSocket upgrade - do TCP-level proxying
          console.log(`[tcp] WebSocket upgrade ${socketData.subdomain} -> :${socketData.targetPort}`);

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
          const url = `http://localhost:${socketData.targetPort}${path}`;

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

          try {
            const response = await fetch(url, {
              method: method,
              headers: fetchHeaders,
              body: method !== "GET" && method !== "HEAD" && body.length > 0 ? body : undefined,
              redirect: "manual",
            });

            // Build response
            let responseText = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
            for (const [key, value] of response.headers) {
              // Skip hop-by-hop headers
              if (!["connection", "keep-alive", "transfer-encoding"].includes(key.toLowerCase())) {
                responseText += `${key}: ${value}\r\n`;
              }
            }
            responseText += "Connection: close\r\n\r\n";

            socket.write(responseText);

            // Stream body
            if (response.body) {
              const reader = response.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                socket.write(value);
              }
            }
            socket.end();
          } catch (e) {
            socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProxy error: ${e}\n`);
            socket.end();
          }
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
