/**
 * Layered configuration for localhome.
 *
 * Precedence (highest wins):
 *   CLI flags > env vars > ./localhome.local.json > ~/.config/localhome/config.json > defaults
 *
 * This module is pure: it only reads JSON files and parses argv. It never spawns
 * processes. `bindHost` and `domain` are left as mode strings/sentinels — the
 * daemon (src/index.ts) resolves "auto"/"tailscale"/null into concrete values,
 * since that requires querying the tailscale CLI.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * `bindHost` accepts a few symbolic modes plus any literal address:
 *   - "auto"      → 0.0.0.0 if a routing domain is set/detected, else 127.0.0.1
 *   - "tailscale" → bind only this machine's tailnet IP (resolved at runtime)
 *   - "loopback"  → 127.0.0.1
 *   - "all"       → 0.0.0.0
 *   - "<addr>"    → bind that literal address (e.g. "100.73.3.108")
 */
export type BindHost = "auto" | "tailscale" | "loopback" | "all" | (string & {});

export interface Config {
  port: number;
  bindHost: BindHost;
  /** Routing suffix, e.g. "home" → app.home. null = auto-detect tailscale name. */
  domain: string | null;
  probe: boolean;
  /** Override mkcert CA root dir. null = env/platform-default discovery. */
  mkcertCaRoot: string | null;
}

export const DEFAULT_CONFIG: Config = {
  port: 9090,
  bindHost: "auto",
  domain: null,
  probe: true,
  mkcertCaRoot: null,
};

/** A config file is a partial Config; unknown keys are ignored. */
type FileConfig = Partial<Config>;

/** Read + parse a JSON config file. Returns {} if missing or malformed. */
function readConfigFile(path: string): FileConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as FileConfig;
    console.log(`[config] Ignoring ${path}: not a JSON object`);
  } catch (e) {
    console.log(`[config] Ignoring ${path}: ${e}`);
  }
  return {};
}

/** Keep only known keys with the right primitive type, so a stray file field can't poison config. */
function sanitize(raw: FileConfig): FileConfig {
  const out: FileConfig = {};
  if (typeof raw.port === "number") out.port = raw.port;
  if (typeof raw.bindHost === "string") out.bindHost = raw.bindHost;
  if (typeof raw.domain === "string" || raw.domain === null) out.domain = raw.domain;
  if (typeof raw.probe === "boolean") out.probe = raw.probe;
  if (typeof raw.mkcertCaRoot === "string" || raw.mkcertCaRoot === null)
    out.mkcertCaRoot = raw.mkcertCaRoot;
  return out;
}

/** XDG-ish user-global config path: ~/.config/localhome/config.json. */
export function xdgConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "localhome", "config.json");
}

/** Repo-local override, relative to the current working directory. */
export const REPO_LOCAL_CONFIG = "localhome.local.json";

/** Layer from env vars (kept as back-compat aliases). */
function envLayer(env: Record<string, string | undefined>): FileConfig {
  const out: FileConfig = {};
  if (env.PORT) {
    const n = parseInt(env.PORT, 10);
    if (!Number.isNaN(n)) out.port = n;
  }
  if (env.BIND_HOST) out.bindHost = env.BIND_HOST;
  // TAILSCALE_HOSTNAME is the legacy name for the routing suffix.
  if (env.TAILSCALE_HOSTNAME) out.domain = env.TAILSCALE_HOSTNAME;
  if (env.LOCALHOME_PROBE !== undefined) out.probe = env.LOCALHOME_PROBE !== "0";
  if (env.MKCERT_CA_ROOT) out.mkcertCaRoot = env.MKCERT_CA_ROOT;
  return out;
}

export interface ParsedArgs {
  config: FileConfig;
  /** Explicit --config PATH, if given. */
  configPath?: string;
}

/** Minimal argv parser for the flags localhome understands (no dependency). */
export function parseArgs(argv: string[]): ParsedArgs {
  const config: FileConfig = {};
  let configPath: string | undefined;

  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`Missing value for ${flag}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port": {
        const n = parseInt(next(i, arg), 10);
        if (!Number.isNaN(n)) config.port = n;
        i++;
        break;
      }
      case "--bind":
        config.bindHost = next(i, arg);
        i++;
        break;
      case "--domain":
        config.domain = next(i, arg);
        i++;
        break;
      case "--mkcert-ca-root":
        config.mkcertCaRoot = next(i, arg);
        i++;
        break;
      case "--config":
        configPath = next(i, arg);
        i++;
        break;
      case "--no-probe":
        config.probe = false;
        break;
      case "--probe":
        config.probe = true;
        break;
      default:
        // Ignore unknown args (e.g. the script path Bun passes through).
        break;
    }
  }

  return { config, configPath };
}

export interface LoadOptions {
  /** Defaults to process.argv.slice(2). */
  argv?: string[];
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to process.cwd(). Used to locate the repo-local config. */
  cwd?: string;
}

/**
 * Resolve the effective config by layering all sources. Pure aside from reading
 * the config JSON files off disk.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const { config: flagConfig, configPath } = parseArgs(argv);

  // File layers: an explicit --config replaces both default file locations.
  let fileLayers: FileConfig[];
  if (configPath) {
    fileLayers = [readConfigFile(configPath)];
  } else {
    fileLayers = [
      readConfigFile(xdgConfigPath()), // lowest of the file layers
      readConfigFile(join(cwd, REPO_LOCAL_CONFIG)), // repo-local overrides XDG
    ];
  }

  const merged: Config = { ...DEFAULT_CONFIG };
  for (const layer of fileLayers) Object.assign(merged, sanitize(layer));
  Object.assign(merged, sanitize(envLayer(env)));
  Object.assign(merged, sanitize(flagConfig));

  return merged;
}
