# localhome

Never remember a port again.

```bash
NAME=app npm run dev
```

Type `app/` in your browser. It just works. No ports. Just names.

You build tools for yourself — dashboards, APIs, little utilities with web UIs. But using them means remembering `localhost:3847` or digging through terminal tabs to find the right port. localhome gives your local services real names so they're always one keystroke away.

## Setup

```bash
# 1. Install the daemon (runs on startup)
just install

# 2. Load the Chrome extension
#    Open chrome://extensions → Developer mode → Load unpacked → select extension/
```

## Usage

Start any server with `NAME`:

```bash
NAME=frontend npm run dev
NAME=api node server.js
NAME=docs python -m http.server
```

Open your browser:

```
frontend/
api/
docs/
```

That's it. No ports to remember, no bookmarks to maintain. Name it, reach it.

> Without the Chrome extension, services are still accessible at `name.localhost:9090`.

## How It Works

localhome is a daemon that auto-discovers local processes by their `NAME` environment variable and routes traffic to them.

The Chrome extension makes bare hostnames like `app/` route through localhome. Unknown names fall back to normal resolution — golinks, DNS, and everything else still work.

```
NAME=app bun run dev        # starts on some port
         ↓
localhome discovers it   # "app" → :3000
         ↓
browser: app/               # proxied to localhost:3000
```

## Configuration

localhome runs with zero config. To change defaults, set options via (highest
precedence first): **CLI flags → environment variables → `./localhome.local.json`
→ `~/.config/localhome/config.json` → built-in defaults**.

```bash
cp localhome.config.example.json ~/.config/localhome/config.json
```

| Option | CLI flag | Env | Default | Meaning |
|--------|----------|-----|---------|---------|
| `port` | `--port N` | `PORT` | `9090` | Port the daemon listens on |
| `bindHost` | `--bind HOST` | `BIND_HOST` | `"auto"` | Bind address (see below) |
| `domain` | `--domain NAME` | `TAILSCALE_HOSTNAME` | auto | Routing suffix — services answer at `<name>.<domain>` |
| `probe` | `--no-probe` | `LOCALHOME_PROBE=0` | `true` | Probe service titles/favicons for the dashboard |
| `mkcertCaRoot` | `--mkcert-ca-root P` | `MKCERT_CA_ROOT` | auto | Override mkcert CA directory |

Both `localhome.local.json` (repo-local) and `~/.config/localhome/config.json` are
git-ignored — your machine's settings never get committed.

### `bindHost` modes

- `"auto"` *(default)* — `0.0.0.0` if a routing domain is set/detected, else `127.0.0.1`
- `"loopback"` — `127.0.0.1` only (this machine)
- `"all"` — `0.0.0.0` (every interface)
- `"tailscale"` — bind **only** this machine's tailnet IP (reachable over Tailscale, invisible on other networks)
- any literal address, e.g. `"100.73.3.108"`

### Remote access over a network (e.g. Tailscale)

`domain` is the routing suffix that lets you reach services from other machines.
On a tailnet it auto-detects your machine name, so services answer at
`http://<name>.<your-machine>:<port>/`. Or set a custom suffix like `home` and
point wildcard DNS (`*.home → this machine`) at the daemon — then any device
resolves `http://app.home:9090/`. Works with any DNS setup, not just Tailscale.

### Dropping the port (`http://app.home/`)

A portless URL means port 80, so the daemon has to listen there. Simplest is
`port: 80` with an all-interfaces bind:

```jsonc
{ "port": 80, "bindHost": "all", "domain": "home" }
```

On macOS an unprivileged process **can** bind `0.0.0.0:80` (since Mojave), so this
needs no root. Trade-off: the daemon then listens on every network the machine
joins. localhome's Host-header allowlist mitigates this — a request whose `Host`
isn't a known service name under your `domain` (e.g. a bare IP) gets `403` — but
treat it as a defense, not a wall.

- **Reachable *only* over your private network?** Binding port 80 to a *single*
  interface needs privilege on macOS — run from a root LaunchDaemon, or keep the
  daemon unprivileged on `9090` and add a boot-time `pf` redirect
  (`rdr ... port 80 -> port 9090`).
- **On Linux**, grant the capability instead of root:
  `sudo setcap CAP_NET_BIND_SERVICE=+ep $(command -v bun)`, then bind a specific
  private IP on port 80.

Over a tailnet (Tailscale/WireGuard) node-to-node traffic is already encrypted in
transit, so plain HTTP on port 80 across the tailnet isn't cleartext on an
untrusted network.

> The Chrome extension's bare-name routing (`app/`) has its port baked into its PAC
> (default `9090`). If you move the daemon to `80`, reach services portlessly via
> `http://app.localhost/` or `http://app.<domain>/`, or update the port in
> `extension/background.js`.

## Commands

```bash
just run        # Run daemon in foreground
just dev        # Run with watch mode
just render     # Generate this machine's launchd plist from the template
just install    # Render + install launchd service
just start      # Start service
just stop       # Stop service
just restart    # Restart service
just logs       # Tail logs
just scan       # Show discovered servers
```

## HTTPS Support

localhome can MITM HTTPS so `https://app/` works with local dev servers that only speak plain HTTP.

```bash
# One-time setup
brew install mkcert
mkcert -install        # creates a local CA and trusts it in your system keychain
```

Restart the daemon after installing. You should see `[certs] Loaded mkcert CA from ...` in the output. After that, `https://app/` just works — localhome generates a cert on the fly for each hostname, signed by mkcert's local CA.

If mkcert isn't installed, HTTPS is silently disabled and everything else works as before.

## Requirements

- macOS or Linux
- Bun
- Chrome (for bare hostname routing via extension)
- mkcert (optional, for HTTPS support)
