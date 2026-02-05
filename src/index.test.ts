import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "net";
import { randomBytes } from "crypto";

let daemon: ChildProcess;
let backend: ChildProcess;
let daemonPort: number;
let backendPort: number;

/** Spawn a process and extract the port from its LISTENING:${port} stdout line. */
function spawnAndGetPort(
  cmd: string,
  args: string[],
  env: Record<string, string>
): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    // Use sh -c exec to avoid Bun tracking the child process
    const fullCmd = [cmd, ...args].join(" ");
    const proc = nodeSpawn("sh", ["-c", `exec ${fullCmd}`], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
    });
    proc.unref();

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timed out waiting for LISTENING line from: ${cmd} ${args.join(" ")}`));
    }, 10_000);

    let buf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/LISTENING:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10) });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Process exited with code ${code} before LISTENING. Output: ${buf}`));
    });
  });
}

/** Send raw bytes over TCP and collect the full response. */
function tcpRequest(
  port: number,
  data: string | Buffer,
  opts?: { waitForClose?: boolean; timeout?: number }
): Promise<Buffer> {
  const timeout = opts?.timeout ?? 5000;
  const waitForClose = opts?.waitForClose ?? true;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error("TCP request timed out"));
      }
    }, timeout);

    const sock = connect(port, "127.0.0.1", () => {
      sock.write(data);
    });

    sock.on("data", (chunk) => {
      chunks.push(chunk);
      if (!waitForClose) {
        clearTimeout(timer);
        sock.destroy();
        resolve(Buffer.concat(chunks));
      }
    });

    sock.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });

    sock.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(err);
      }
    });
  });
}

/** Open a raw TCP socket and return it for multi-step interactions (e.g. CONNECT tunnel). */
function tcpConnect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => resolve(sock));
    sock.on("error", reject);
  });
}

/** Collect data from a socket until a condition is met. */
function collectUntil(
  sock: Socket,
  predicate: (buf: Buffer) => boolean,
  timeout = 5000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      resolve(Buffer.concat(chunks));
    }, timeout);

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      if (predicate(combined)) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        sock.removeListener("end", onEnd);
        sock.removeListener("close", onClose);
        resolve(combined);
      }
    };

    const onEnd = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };

    const onClose = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };

    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("close", onClose);
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Parse HTTP status code from raw response bytes. */
function parseStatusCode(resp: Buffer): number {
  const line = resp.toString("utf8").split("\r\n")[0];
  return parseInt(line.split(" ")[1], 10);
}

/** Parse HTTP response body (after \r\n\r\n). */
function parseBody(resp: Buffer): string {
  const str = resp.toString("utf8");
  const idx = str.indexOf("\r\n\r\n");
  return idx >= 0 ? str.slice(idx + 4) : "";
}

/** Parse HTTP headers into a map. */
function parseHeaders(resp: Buffer): Map<string, string> {
  const str = resp.toString("utf8");
  const headerEnd = str.indexOf("\r\n\r\n");
  const headerSection = str.slice(str.indexOf("\r\n") + 2, headerEnd);
  const headers = new Map<string, string>();
  for (const line of headerSection.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers.set(line.slice(0, idx).toLowerCase().trim(), line.slice(idx + 1).trim());
    }
  }
  return headers;
}

// -- WebSocket helpers --

/** Build a WebSocket upgrade request. */
function wsUpgradeRequest(host: string, path = "/"): string {
  const key = randomBytes(16).toString("base64");
  return (
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`
  );
}

/** Encode a masked WebSocket text frame (client -> server must be masked). */
function encodeWsFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = 0x80 | payload.length; // MASK bit + length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

/** Decode an unmasked WebSocket text frame (server -> client is unmasked). */
function decodeWsFrame(data: Buffer): { opcode: number; payload: string } | null {
  if (data.length < 2) return null;
  const opcode = data[0] & 0x0f;
  const isMasked = (data[1] & 0x80) !== 0;
  let payloadLen = data[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (data.length < 4) return null;
    payloadLen = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (data.length < 10) return null;
    payloadLen = Number(data.readBigUInt64BE(2));
    offset = 10;
  }

  if (isMasked) offset += 4; // skip mask key (shouldn't happen server->client)

  if (data.length < offset + payloadLen) return null;
  const payload = data.slice(offset, offset + payloadLen).toString("utf8");
  return { opcode, payload };
}

// -- Retry helper for mapping cache race --

async function retryRequest(
  fn: () => Promise<Buffer>,
  check: (resp: Buffer) => boolean,
  maxRetries = 10,
  delayMs = 500
): Promise<Buffer> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fn();
      if (check(resp)) return resp;
    } catch {
      // connection refused or closed — retry
    }
    await Bun.sleep(delayMs);
  }
  throw new Error("retryRequest exhausted");
}

beforeAll(async () => {
  const bun = process.argv[0]; // path to bun

  const [d, b] = await Promise.all([
    spawnAndGetPort(bun, ["src/index.ts"], { PORT: "0" }),
    spawnAndGetPort(bun, ["src/test-backend.ts"], {
      PORT: "0",
      NAME: "testapp",
    }),
  ]);

  daemon = d.proc;
  daemonPort = d.port;
  backend = b.proc;
  backendPort = b.port;

}, 15_000);

afterAll(() => {
  for (const pid of [daemon?.pid, backend?.pid]) {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

describe("reverse proxy", () => {
  test("HTTP — routes by subdomain and proxies to backend", async () => {
    const resp = await retryRequest(
      () =>
        tcpRequest(
          daemonPort,
          `GET / HTTP/1.1\r\nHost: testapp.localhost:${daemonPort}\r\n\r\n`
        ),
      (r) => parseStatusCode(r) === 200
    );

    expect(parseStatusCode(resp)).toBe(200);
    const body = JSON.parse(parseBody(resp));
    expect(body.name).toBe("testapp");
    expect(body.path).toBe("/");
  });

  test("WebSocket — upgrade and echo", async () => {
    const sock = await tcpConnect(daemonPort);

    // Send upgrade request
    sock.write(wsUpgradeRequest(`testapp.localhost:${daemonPort}`));

    // Wait for 101 response
    const upgradeResp = await collectUntil(sock, (buf) =>
      buf.toString("utf8").includes("\r\n\r\n")
    );
    expect(parseStatusCode(upgradeResp)).toBe(101);

    // Send a text frame
    const testMsg = "hello localhostess";
    sock.write(encodeWsFrame(testMsg));

    // Read echo frame
    const frameData = await collectUntil(
      sock,
      (buf) => {
        const frame = decodeWsFrame(buf);
        return frame !== null && frame.payload.length > 0;
      },
      3000
    );

    const decoded = decodeWsFrame(frameData);
    expect(decoded).not.toBeNull();
    expect(decoded!.payload).toBe(testMsg);

    sock.destroy();
  });

  test("HTTP — large response body arrives intact", async () => {
    const size = 262144; // 256KB
    const resp = await retryRequest(
      () =>
        tcpRequest(
          daemonPort,
          `GET /big?n=${size} HTTP/1.1\r\nHost: testapp.localhost:${daemonPort}\r\n\r\n`,
          { timeout: 10_000 }
        ),
      (r) => parseStatusCode(r) === 200
    );

    expect(parseStatusCode(resp)).toBe(200);
    const body = parseBody(resp);
    expect(body.length).toBe(size);
    // Verify content matches expected pattern
    const chunk = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n";
    const expected = chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size);
    expect(body).toBe(expected);
  });

  test("unknown service returns 404", async () => {
    const resp = await tcpRequest(
      daemonPort,
      `GET / HTTP/1.1\r\nHost: nonexistent.localhost:${daemonPort}\r\n\r\n`
    );
    expect(parseStatusCode(resp)).toBe(404);
  });
});

describe("forward proxy", () => {
  test("HTTP — absolute URI with Host rewriting", async () => {
    const resp = await retryRequest(
      () =>
        tcpRequest(
          daemonPort,
          `GET http://testapp/ HTTP/1.1\r\nHost: testapp\r\n\r\n`
        ),
      (r) => parseStatusCode(r) === 200
    );

    expect(parseStatusCode(resp)).toBe(200);
    const body = JSON.parse(parseBody(resp));
    expect(body.name).toBe("testapp");
    expect(body.headers.host).toBe(`localhost:${backendPort}`);
  });

  test("CONNECT tunnel — bidirectional TCP pipe", async () => {
    const sock = await tcpConnect(daemonPort);

    // Send CONNECT
    sock.write(`CONNECT testapp:80 HTTP/1.1\r\n\r\n`);

    // Wait for 200 Connection Established
    const connectResp = await collectUntil(sock, (buf) =>
      buf.toString("utf8").includes("\r\n\r\n")
    );
    expect(connectResp.toString("utf8")).toContain("200 Connection Established");

    // Now send an HTTP request through the tunnel
    sock.write(`GET / HTTP/1.1\r\nHost: testapp\r\nConnection: close\r\n\r\n`);

    // Read response through tunnel
    const tunnelResp = await collectUntil(
      sock,
      (buf) => {
        const str = buf.toString("utf8");
        return str.includes("\r\n\r\n") && str.includes("}");
      },
      5000
    );

    expect(parseStatusCode(tunnelResp)).toBe(200);
    const body = JSON.parse(parseBody(tunnelResp));
    expect(body.name).toBe("testapp");
    // Host header should be rewritten to localhost:<port> so backends accept it
    expect(body.headers.host).toBe(`localhost:${backendPort}`);

    sock.destroy();
  });

  test("unknown service closes connection (forward proxy)", async () => {
    const resp = await tcpRequest(
      daemonPort,
      `GET http://nonexistent/ HTTP/1.1\r\nHost: nonexistent\r\n\r\n`,
      { timeout: 2000 }
    );
    // Should get empty response (connection closed without reply)
    expect(resp.length).toBe(0);
  });

  test("unknown service closes connection (CONNECT)", async () => {
    const resp = await tcpRequest(
      daemonPort,
      `CONNECT nonexistent:80 HTTP/1.1\r\n\r\n`,
      { timeout: 2000 }
    );
    expect(resp.length).toBe(0);
  });
});

describe("dashboard & PAC", () => {
  test("dashboard serves HTML at root", async () => {
    const resp = await tcpRequest(
      daemonPort,
      `GET / HTTP/1.1\r\nHost: localhost:${daemonPort}\r\n\r\n`
    );
    expect(parseStatusCode(resp)).toBe(200);
    expect(parseBody(resp)).toContain("localhostess");
  });

  test("PAC file serves valid JS", async () => {
    const resp = await tcpRequest(
      daemonPort,
      `GET /proxy.pac HTTP/1.1\r\nHost: localhost:${daemonPort}\r\n\r\n`
    );
    expect(parseStatusCode(resp)).toBe(200);
    const headers = parseHeaders(resp);
    expect(headers.get("content-type")).toBe("application/x-ns-proxy-autoconfig");
    expect(parseBody(resp)).toContain("FindProxyForURL");
  });
});
