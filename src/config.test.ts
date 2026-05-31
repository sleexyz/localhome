import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadConfig,
  parseArgs,
  DEFAULT_CONFIG,
  REPO_LOCAL_CONFIG,
} from "./config";

// Empty env so the host's real env (PORT, TAILSCALE_HOSTNAME, …) never leaks in.
const EMPTY_ENV: Record<string, string | undefined> = {};

describe("parseArgs", () => {
  test("parses all flags", () => {
    const { config, configPath } = parseArgs([
      "--port", "1234",
      "--bind", "tailscale",
      "--domain", "home",
      "--mkcert-ca-root", "/ca",
      "--config", "/c.json",
      "--no-probe",
    ]);
    expect(config.port).toBe(1234);
    expect(config.bindHost).toBe("tailscale");
    expect(config.domain).toBe("home");
    expect(config.mkcertCaRoot).toBe("/ca");
    expect(config.probe).toBe(false);
    expect(configPath).toBe("/c.json");
  });

  test("ignores unknown args and bad port", () => {
    const { config } = parseArgs(["src/index.ts", "--port", "notanumber"]);
    expect(config.port).toBeUndefined();
  });

  test("--probe overrides an earlier --no-probe", () => {
    const { config } = parseArgs(["--no-probe", "--probe"]);
    expect(config.probe).toBe(true);
  });
});

describe("loadConfig precedence", () => {
  let cwd: string;
  let xdgHome: string;
  let savedXdg: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lh-cwd-"));
    xdgHome = mkdtempSync(join(tmpdir(), "lh-xdg-"));
    // xdgConfigPath() reads process.env.XDG_CONFIG_HOME directly.
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgHome;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(xdgHome, { recursive: true, force: true });
  });

  const writeXdg = (obj: unknown) => {
    const dir = join(xdgHome, "localhome");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
  };
  const writeRepoLocal = (obj: unknown) =>
    writeFileSync(join(cwd, REPO_LOCAL_CONFIG), JSON.stringify(obj));

  test("returns defaults when nothing is set", () => {
    const c = loadConfig({ argv: [], env: EMPTY_ENV, cwd });
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  test("xdg file overrides defaults", () => {
    writeXdg({ domain: "xdg", port: 1111 });
    const c = loadConfig({ argv: [], env: EMPTY_ENV, cwd });
    expect(c.domain).toBe("xdg");
    expect(c.port).toBe(1111);
  });

  test("repo-local overrides xdg", () => {
    writeXdg({ domain: "xdg", port: 1111 });
    writeRepoLocal({ domain: "repo" });
    const c = loadConfig({ argv: [], env: EMPTY_ENV, cwd });
    expect(c.domain).toBe("repo");
    expect(c.port).toBe(1111); // unset in repo-local, inherited from xdg
  });

  test("env overrides files; TAILSCALE_HOSTNAME maps to domain", () => {
    writeRepoLocal({ domain: "repo" });
    const c = loadConfig({
      argv: [],
      env: { TAILSCALE_HOSTNAME: "envdom", LOCALHOME_PROBE: "0", BIND_HOST: "all" },
      cwd,
    });
    expect(c.domain).toBe("envdom");
    expect(c.probe).toBe(false);
    expect(c.bindHost).toBe("all");
  });

  test("flags override env", () => {
    const c = loadConfig({
      argv: ["--domain", "flagdom", "--bind", "loopback"],
      env: { TAILSCALE_HOSTNAME: "envdom", BIND_HOST: "all" },
      cwd,
    });
    expect(c.domain).toBe("flagdom");
    expect(c.bindHost).toBe("loopback");
  });

  test("--config replaces both default file locations", () => {
    writeXdg({ domain: "xdg" });
    writeRepoLocal({ domain: "repo" });
    const explicit = join(cwd, "explicit.json");
    writeFileSync(explicit, JSON.stringify({ domain: "explicit" }));
    const c = loadConfig({ argv: ["--config", explicit], env: EMPTY_ENV, cwd });
    expect(c.domain).toBe("explicit");
  });

  test("malformed file is ignored, falls back to defaults", () => {
    const dir = join(xdgHome, "localhome");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");
    const c = loadConfig({ argv: [], env: EMPTY_ENV, cwd });
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  test("wrong-typed fields are dropped", () => {
    writeXdg({ port: "9090", domain: 42, probe: "yes" });
    const c = loadConfig({ argv: [], env: EMPTY_ENV, cwd });
    expect(c.port).toBe(DEFAULT_CONFIG.port);
    expect(c.domain).toBe(DEFAULT_CONFIG.domain);
    expect(c.probe).toBe(DEFAULT_CONFIG.probe);
  });
});
