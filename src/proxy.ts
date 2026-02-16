/**
 * Shared proxy types and utilities for localhome
 */

import type { Socket } from "bun";

// ---- Types ----

export type SocketData = {
  buffer: Buffer;
  headersParsed: boolean;
  isUpgrade: boolean;
  backend: Socket<BackendData> | null;
  host: string | null;
  subdomain: string | null;
  targetPort: number | null;
  pendingWrite: Uint8Array | null;
  endAfterFlush: boolean;
};

export type BackendData = {
  client: Socket<SocketData>;
  rewriteHost?: string;
};

// ---- Header parsing ----

export function parseHttpHeaders(data: Buffer): {
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
    headerEndIndex: headerEnd + 4,
  };
}

export function isWebSocketUpgrade(headers: Map<string, string>): boolean {
  const upgrade = headers.get("upgrade");
  const connection = headers.get("connection");
  return (
    upgrade?.toLowerCase() === "websocket" &&
    (connection?.toLowerCase().includes("upgrade") ?? false)
  );
}

// ---- Socket utilities ----

/** Write data to socket with backpressure handling, then close. */
export function writeAllAndEnd(socket: Socket<SocketData>, data: Uint8Array) {
  const written = socket.write(data);
  if (written < data.byteLength) {
    socket.data.pendingWrite = data.subarray(written);
    socket.data.endAfterFlush = true;
  } else {
    socket.end();
  }
}

/** Create backend socket handlers with common close/error/end patterns. */
export function makeBackendSocketHandlers(
  clientSocket: Socket<SocketData>,
  opts?: {
    onOpen?: (backendSocket: Socket<BackendData>) => void;
    rewriteHost?: string;
    label?: string;
  }
) {
  return {
    open(backendSocket: Socket<BackendData>) {
      backendSocket.data = {
        client: clientSocket,
        rewriteHost: opts?.rewriteHost,
      };
      opts?.onOpen?.(backendSocket);
    },
    data(backendSocket: Socket<BackendData>, data: Buffer) {
      try {
        const client = backendSocket.data.client;
        if (client.data.pendingWrite) {
          // Already have pending data — just append, wait for drain
          client.data.pendingWrite = Buffer.concat([
            client.data.pendingWrite,
            data,
          ]);
          return;
        }
        const written = client.write(data);
        if (written < data.byteLength) {
          // Backpressure: buffer remaining bytes for the client's drain handler
          client.data.pendingWrite = Buffer.from(data.subarray(written));
        }
      } catch (e) {
        backendSocket.end();
      }
    },
    close(backendSocket: Socket<BackendData>) {
      if (opts?.label) console.log(`[tcp] Backend closed for ${opts.label}`);
      try {
        backendSocket.data.client.end();
      } catch (e) {}
    },
    error(backendSocket: Socket<BackendData>, error: Error) {
      console.log(
        `[tcp] Backend error${opts?.label ? ` for ${opts.label}` : ""}: ${error.message}`
      );
      try {
        backendSocket.data.client.end();
      } catch (e) {}
    },
    end(backendSocket: Socket<BackendData>) {
      try {
        backendSocket.data.client.end();
      } catch (e) {}
    },
  };
}

// ---- Proxy functions ----

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
];

/** Proxy an HTTP request via fetch() and send the response back to the client socket. */
export async function proxyHttpRequest(
  socket: Socket<SocketData>,
  opts: {
    method: string;
    path: string;
    targetPort: number;
    headers: Map<string, string>;
    body: Buffer;
    rewriteHost?: boolean;
  }
) {
  const url = `http://localhost:${opts.targetPort}${opts.path}`;

  const fetchHeaders = new Headers();
  for (const [key, value] of opts.headers) {
    if (!HOP_BY_HOP.includes(key)) {
      fetchHeaders.set(key, value);
    }
  }
  // Strip conditional headers to avoid 304 loops
  fetchHeaders.delete("if-none-match");
  fetchHeaders.delete("if-modified-since");
  if (opts.rewriteHost) {
    fetchHeaders.set("host", `localhost:${opts.targetPort}`);
  }
  // Disable keep-alive to prevent RST on pooled connections
  fetchHeaders.set("connection", "close");

  try {
    const response = await fetch(url, {
      method: opts.method,
      headers: fetchHeaders,
      body:
        opts.method !== "GET" && opts.method !== "HEAD" && opts.body.length > 0
          ? opts.body
          : undefined,
      redirect: "manual",
    });

    let responseText = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
    for (const [key, value] of response.headers) {
      if (
        ![
          "connection",
          "keep-alive",
          "transfer-encoding",
          "content-length",
          "content-encoding",
        ].includes(key.toLowerCase())
      ) {
        responseText += `${key}: ${value}\r\n`;
      }
    }
    responseText += "Connection: close\r\n\r\n";

    const headerBytes = new TextEncoder().encode(responseText);
    const bodyBytes = new Uint8Array(await response.arrayBuffer());
    const fullResp = new Uint8Array(
      headerBytes.byteLength + bodyBytes.byteLength
    );
    fullResp.set(headerBytes, 0);
    fullResp.set(bodyBytes, headerBytes.byteLength);
    writeAllAndEnd(socket, fullResp);
  } catch (e) {
    socket.write(
      `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProxy error: ${e}\n`
    );
    socket.end();
  }
}

/** Proxy a WebSocket upgrade via raw TCP pipe. */
export async function proxyWebSocket(
  socket: Socket<SocketData>,
  opts: {
    targetPort: number;
    subdomain: string;
    rawBuffer: Buffer;
  }
): Promise<Socket<BackendData> | null> {
  console.log(
    `[tcp] WebSocket upgrade ${opts.subdomain} -> :${opts.targetPort}`
  );

  try {
    const backend = await Bun.connect<BackendData>({
      hostname: "localhost",
      port: opts.targetPort,
      socket: makeBackendSocketHandlers(socket, {
        label: opts.subdomain,
        onOpen(backendSocket) {
          backendSocket.write(opts.rawBuffer);
        },
      }),
    });
    return backend;
  } catch (e) {
    console.log(`[tcp] Failed to connect to backend: ${e}`);
    socket.write(
      `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nFailed to connect to backend\n`
    );
    socket.end();
    return null;
  }
}
