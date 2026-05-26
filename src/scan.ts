/**
 * Server discovery module
 * Finds running processes with LOCALHOST_NAME env var and their listening ports
 */

import { $ } from "bun";

interface Server {
  name: string;
  port: number;
  pid: number;
  command: string;
}

/**
 * Parse environment variables from `ps -Eww` output
 * Handles values with spaces by splitting on ` KEY=` pattern
 */
function parseEnvVars(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  // Split on space followed by KEY= pattern
  const parts = raw.split(/\s(?=[a-zA-Z_][a-zA-Z0-9_]*=)/);
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex > 0) {
      const key = part.slice(0, eqIndex);
      const value = part.slice(eqIndex + 1);
      vars[key] = value;
    }
  }
  return vars;
}

/**
 * Get environment variables for a process
 */
async function getProcessEnv(pid: number): Promise<Record<string, string>> {
  try {
    const result = await $`ps -Eww -p ${pid} -o command=`.text();
    return parseEnvVars(result);
  } catch {
    return {};
  }
}

/**
 * Get command line for a process
 */
async function getProcessCommand(pid: number): Promise<string> {
  try {
    const result = await $`ps -p ${pid} -o command=`.text();
    return result.trim();
  } catch {
    return "";
  }
}

export type SocketScope = "local" | "exposed";

export interface ListeningSocket {
  pid: number;
  port: number;
  scope: SocketScope; // loopback-only vs reachable on other interfaces
}

/** True if a bind address is loopback-only (not reachable off-machine). */
function isLoopbackAddr(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

/**
 * Find all listening TCP sockets, tagged with their bind scope.
 */
async function findListeningSockets(): Promise<ListeningSocket[]> {
  const sockets: ListeningSocket[] = [];
  try {
    const result = await $`lsof -i -P -n`.text();
    for (const line of result.split("\n")) {
      if (!line.includes("LISTEN")) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const pid = parseInt(parts[1], 10);
      const addrPort = parts[8]; // e.g., "*:3000", "127.0.0.1:8888", "[::1]:5173"
      const portMatch = addrPort.match(/:(\d+)$/);
      if (!portMatch) continue;

      const port = parseInt(portMatch[1], 10);
      const host = addrPort.slice(0, addrPort.length - portMatch[0].length);
      sockets.push({ pid, port, scope: isLoopbackAddr(host) ? "local" : "exposed" });
    }
  } catch (e) {
    console.error("Failed to run lsof:", e);
  }
  return sockets;
}

/**
 * Find all TCP servers listening on localhost
 * Returns map of PID -> ports
 */
async function findListeningPorts(): Promise<Map<number, number[]>> {
  const pidPorts = new Map<number, number[]>();
  for (const { pid, port } of await findListeningSockets()) {
    const existing = pidPorts.get(pid) || [];
    if (!existing.includes(port)) {
      existing.push(port);
      pidPorts.set(pid, existing);
    }
  }
  return pidPorts;
}

const DEBUG_PORTS = new Set([9229, 9222, 5858]);
const EPHEMERAL_PORT_MIN = 49152;

/**
 * Pick the best port from a list of candidates.
 * Filter pipeline: remove debug ports, remove ephemeral ports, take lowest.
 * Fallback: lowest from the original set.
 */
export function pickPort(ports: number[]): number {
  const filtered = ports
    .filter((p) => !DEBUG_PORTS.has(p) && p < EPHEMERAL_PORT_MIN);
  if (filtered.length > 0) return Math.min(...filtered);
  return Math.min(...ports);
}

/**
 * Scan for servers with LOCALHOST_NAME env var
 */
export async function scanServers(): Promise<Server[]> {
  const pidPorts = await findListeningPorts();

  const DEBUG = process.env.DEBUG === "1";
  if (DEBUG) console.log(`[scan] Found ${pidPorts.size} processes with listening ports`);

  // First pass: collect entries grouped by NAME
  const byName = new Map<string, { pid: number; ports: number[]; command: string }[]>();

  for (const [pid, ports] of pidPorts) {
    const env = await getProcessEnv(pid);
    const name = env["NAME"];

    if (DEBUG) {
      const hasVhost = name ? `NAME=${name}` : "no NAME";
      console.log(`[scan] PID ${pid} ports=${ports.join(",")} ${hasVhost}`);
    }

    if (name) {
      const command = await getProcessCommand(pid);
      const entries = byName.get(name) || [];
      entries.push({ pid, ports, command: command.slice(0, 80) });
      byName.set(name, entries);
    }
  }

  // Second pass: pick one port per name
  const servers: Server[] = [];
  for (const [name, entries] of byName) {
    const allPorts = entries.flatMap((e) => e.ports);
    const chosenPort = pickPort(allPorts);
    // Use the pid/command of whichever entry owns the chosen port
    const owner = entries.find((e) => e.ports.includes(chosenPort)) || entries[0];
    servers.push({ name, port: chosenPort, pid: owner.pid, command: owner.command });
  }

  return servers;
}

/**
 * Build subdomain -> port mapping
 */
export async function buildMapping(): Promise<Map<string, number>> {
  const servers = await scanServers();
  const mapping = new Map<string, number>();
  for (const server of servers) {
    mapping.set(server.name, server.port);
  }
  return mapping;
}

// ---- Unregistered service discovery ----
//
// Everything listening that does NOT have a NAME env var. These can't be
// routed (no name), so the dashboard shows them read-only with enough
// metadata to tell them apart: cwd, command, ports, bind scope, uptime, pid,
// and a best-effort probed page title + favicon.

export interface UnregisteredService {
  pid: number;
  process: string; // short name derived from argv[0], e.g. "node", "ollama"
  command: string; // full command line (no env)
  ports: number[]; // non-ephemeral listening ports, sorted
  primaryPort: number;
  scope: "local" | "exposed" | "mixed";
  cwd: string;
  etime: string; // raw `ps` elapsed time (e.g. "01-14:59:59")
  isDev: boolean; // heuristic: cwd under $HOME and not an app bundle
  name?: string; // ephemeral <project>-<role> route (dev services only)
  title?: string; // probed <title>
  favicon?: string; // probed favicon as a data: URI
}

/** Short process name from a command line's argv[0]. */
function shortProcessName(command: string): string {
  const argv0 = command.trim().split(/\s+/)[0] || "";
  return argv0.split("/").pop() || argv0;
}

// ---- Ephemeral name generation for unregistered dev services ----
//
// A service with no NAME still gets a routable handle, derived purely from what
// it is: <project>-<role>, e.g. `edging-streamlit`. No persistent state — the
// name is recomputed from the live process list, so it exists only while the
// service runs. The proxy reverses it by re-deriving names and matching.

const INTERPRETERS = new Set([
  "node", "nodejs", "bun", "deno", "python", "python2", "python3",
  "ruby", "php", "perl", "sh", "bash", "zsh",
]);

/** Lowercase DNS-label slug: keep [a-z0-9], collapse the rest to hyphens, trim. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Basename of a script path, minus a known source extension. */
function scriptBase(token: string): string {
  const base = token.split("/").pop() || token;
  return base.replace(/\.(py|js|mjs|cjs|ts|tsx|jsx|rb|php|pl|sh)$/i, "");
}

/** Drop a trailing version from an interpreter name: "python3.14" -> "python". */
function stripVersion(name: string): string {
  return name.replace(/[0-9][0-9.]*$/, "");
}

/**
 * Infer a short role from a command line, seeing through interpreters:
 *   python .venv/bin/streamlit run app.py  -> streamlit
 *   python -m sky.server.server            -> sky
 *   node node_modules/.bin/vite            -> vite
 *   marimo edit notebooks/                 -> marimo
 */
function roleName(command: string, fallback: string): string {
  const toks = command.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return slug(fallback);
  const arg0 = (toks[0].split("/").pop() || "").toLowerCase();
  if (!INTERPRETERS.has(arg0) && !INTERPRETERS.has(stripVersion(arg0))) {
    return slug(scriptBase(toks[0])) || slug(fallback);
  }
  // Interpreter — dig for the real entrypoint.
  for (let j = 1; j < toks.length; j++) {
    const t = toks[j];
    if (t === "-m" && toks[j + 1]) return slug(toks[j + 1].split(".")[0]); // module head
    if ((t === "run" || t === "exec") && toks[j + 1] && !toks[j + 1].startsWith("-"))
      return slug(scriptBase(toks[j + 1]));
    if (t.startsWith("-")) continue; // skip flags
    return slug(scriptBase(t)); // first bare token = script/tool
  }
  return slug(stripVersion(arg0)); // bare interpreter
}

/** Project label = basename of the working directory. */
function projectName(cwd: string): string {
  return slug(cwd.split("/").filter(Boolean).pop() || "");
}

/**
 * Assign ephemeral `<project>-<role>` names to dev services in place. Collisions
 * (same project + role) are disambiguated with the port, which is stable per
 * process; unique names stay clean.
 */
function assignNames(services: UnregisteredService[]): void {
  const dev = services.filter((s) => s.isDev);
  const base = new Map<UnregisteredService, string>();
  for (const s of dev) {
    const name = [projectName(s.cwd), roleName(s.command, s.process)]
      .filter(Boolean)
      .join("-");
    if (name) base.set(s, name);
  }
  const counts = new Map<string, number>();
  for (const n of base.values()) counts.set(n, (counts.get(n) || 0) + 1);
  for (const s of dev) {
    const b = base.get(s);
    if (!b) continue;
    s.name = counts.get(b)! > 1 ? `${b}-${s.primaryPort}` : b;
  }
}

/** Batched env read for many PIDs (one `ps -Eww`). Used to detect NAME + PWD. */
async function getEnvBatched(pids: number[]): Promise<Map<number, Record<string, string>>> {
  const map = new Map<number, Record<string, string>>();
  if (pids.length === 0) return map;
  try {
    const out = await $`ps -Eww -p ${pids.join(",")} -o pid=,command=`.text();
    for (const line of out.split("\n")) {
      const t = line.trim();
      const sp = t.indexOf(" ");
      if (sp < 0) continue;
      const pid = parseInt(t.slice(0, sp), 10);
      if (!pid) continue;
      map.set(pid, parseEnvVars(t.slice(sp + 1)));
    }
  } catch {}
  return map;
}

/**
 * Batched elapsed-time, executable name, and full command for many PIDs.
 * Two `ps` calls: one trailing `comm=` (executable path — safe with spaces) for
 * a clean process name, one trailing `command=` for the full command line.
 */
async function getDetailsBatched(
  pids: number[]
): Promise<Map<number, { etime: string; comm: string; command: string }>> {
  const map = new Map<number, { etime: string; comm: string; command: string }>();
  if (pids.length === 0) return map;
  const csv = pids.join(",");
  try {
    const [etimeOut, cmdOut] = await Promise.all([
      $`ps -p ${csv} -o pid=,etime=,comm=`.text(),
      $`ps -p ${csv} -o pid=,command=`.text(),
    ]);
    for (const line of etimeOut.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      map.set(parseInt(m[1], 10), { etime: m[2], comm: m[3], command: "" });
    }
    for (const line of cmdOut.split("\n")) {
      const t = line.trim();
      const sp = t.indexOf(" ");
      if (sp < 0) continue;
      const pid = parseInt(t.slice(0, sp), 10);
      const e = map.get(pid);
      if (e) e.command = t.slice(sp + 1);
    }
  } catch {}
  return map;
}

/** Batched working directory for many PIDs (one `lsof -d cwd`). */
async function getCwdBatched(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  try {
    const out = await $`lsof -p ${pids.join(",")} -a -d cwd -Fpn`.text();
    let cur = 0;
    for (const line of out.split("\n")) {
      if (line[0] === "p") cur = parseInt(line.slice(1), 10);
      else if (line[0] === "n" && cur && !map.has(cur)) map.set(cur, line.slice(1));
    }
  } catch {}
  return map;
}

/** Read a response body up to `cap` bytes, then cancel. Keeps probes cheap. */
async function readCapped(resp: Response, cap = 65536): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  let got = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      out += dec.decode(value, { stream: true });
      if (got >= cap) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
  } catch {}
  return out;
}

/** Best-effort: fetch the service root and extract its <title>. */
async function probeTitle(base: string): Promise<string | undefined> {
  try {
    const resp = await fetch(`${base}/`, {
      signal: AbortSignal.timeout(800),
      redirect: "manual",
    });
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("html")) {
      try { await resp.body?.cancel(); } catch {}
      return undefined;
    }
    const html = await readCapped(resp);
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return undefined;
    const title = m[1].replace(/\s+/g, " ").trim();
    return title.slice(0, 80) || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort: fetch /favicon.ico and inline it as a data: URI (avoids mixed-content on the https dashboard). */
async function probeFavicon(base: string): Promise<string | undefined> {
  try {
    const resp = await fetch(`${base}/favicon.ico`, { signal: AbortSignal.timeout(800) });
    if (!resp.ok) {
      try { await resp.body?.cancel(); } catch {}
      return undefined;
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      try { await resp.body?.cancel(); } catch {}
      return undefined;
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 32768) return undefined;
    return `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function probeService(port: number): Promise<{ title?: string; favicon?: string }> {
  const base = `http://127.0.0.1:${port}`;
  const [title, favicon] = await Promise.all([probeTitle(base), probeFavicon(base)]);
  return { title, favicon };
}

/**
 * Scan for listening processes WITHOUT a NAME env var (the un-routable ones).
 * Independent of the routing scan so the hot path stays untouched.
 */
export async function scanUnregistered(
  opts?: { probe?: boolean }
): Promise<UnregisteredService[]> {
  const probe = opts?.probe ?? true;
  const sockets = await findListeningSockets();
  if (sockets.length === 0) return [];

  // Group ports + scopes per PID.
  const byPid = new Map<number, { ports: Set<number>; scopes: Set<SocketScope> }>();
  for (const s of sockets) {
    const e = byPid.get(s.pid) || { ports: new Set<number>(), scopes: new Set<SocketScope>() };
    e.ports.add(s.port);
    e.scopes.add(s.scope);
    byPid.set(s.pid, e);
  }

  const allPids = [...byPid.keys()];
  const envByPid = await getEnvBatched(allPids);

  // Unregistered = no (or empty) NAME env var.
  const unregPids = allPids.filter((pid) => !envByPid.get(pid)?.["NAME"]);
  if (unregPids.length === 0) return [];

  const [detailByPid, cwdByPid] = await Promise.all([
    getDetailsBatched(unregPids),
    getCwdBatched(unregPids),
  ]);

  const home = process.env.HOME || "";
  const services: UnregisteredService[] = [];

  for (const pid of unregPids) {
    const info = byPid.get(pid)!;
    const allPorts = [...info.ports].sort((a, b) => a - b);
    const nonEphemeral = allPorts.filter((p) => p < EPHEMERAL_PORT_MIN);
    // Skip processes that only hold ephemeral ports — these are worker/internal
    // sockets (HMR, IPC), never something you'd open in a browser.
    if (nonEphemeral.length === 0) continue;

    const detail = detailByPid.get(pid);
    const command = detail?.command || "";
    const comm = detail?.comm || "";
    const cwd = cwdByPid.get(pid) || envByPid.get(pid)?.["PWD"] || "";
    const scopes = info.scopes;
    const scope: "local" | "exposed" | "mixed" =
      scopes.has("exposed") && scopes.has("local")
        ? "mixed"
        : scopes.has("exposed")
          ? "exposed"
          : "local";

    services.push({
      pid,
      process: comm ? comm.split("/").pop() || comm : shortProcessName(command),
      command,
      ports: nonEphemeral,
      primaryPort: pickPort(allPorts),
      scope,
      cwd,
      etime: detail?.etime || "",
      isDev: !!cwd && !!home && cwd.startsWith(home) && !cwd.includes("/Library/"),
    });
  }

  if (probe) {
    await Promise.all(
      services.map(async (s) => {
        const r = await probeService(s.primaryPort);
        s.title = r.title;
        s.favicon = r.favicon;
      })
    );
  }

  assignNames(services);

  // Dev servers first, then grouped by project (cwd), then by port.
  services.sort((a, b) => {
    if (a.isDev !== b.isDev) return a.isDev ? -1 : 1;
    if (a.cwd !== b.cwd) return a.cwd.localeCompare(b.cwd);
    return a.primaryPort - b.primaryPort;
  });

  return services;
}

// CLI: run directly to test scanning
if (import.meta.main) {
  console.log("Scanning for servers with NAME...\n");

  const servers = await scanServers();

  if (servers.length === 0) {
    console.log("No servers found with NAME env var.");
    console.log("\nTry starting a server with:");
    console.log('  NAME=test bun -e "Bun.serve({port: 4567, fetch: () => new Response(\'hello\')})"');
  } else {
    console.log("Found servers:\n");
    for (const server of servers) {
      console.log(`┌─────────────────────────────────────────`);
      console.log(`│ ${server.name}.localhost:9999 → :${server.port}`);
      console.log(`├─────────────────────────────────────────`);
      console.log(`│ PID:     ${server.pid}`);
      console.log(`│ Command: ${server.command}...`);
      console.log(`└─────────────────────────────────────────\n`);
    }
  }
}
