# localworld

A local router for all your development web servers. Route `*.localhost` subdomains to the right port automatically.

## Problem

When working on multiple projects simultaneously:
- Each project runs on a different port (3000, 3001, 8080, 5173, etc.)
- Hard to remember which port belongs to which project
- Some projects have multiple services on multiple ports
- Constantly typing `localhost:XXXX` is tedious
- No easy way to see what's running at a glance

## Solution

localworld acts as a reverse proxy that:
1. Listens on a configurable port (e.g., 3080)
2. Routes `*.localhost` subdomain requests to the appropriate local port
3. Auto-discovers running servers and their ports
4. Maps subdomains to ports via environment variables, config, or heuristics

### Example Usage

Instead of:
```
http://localhost:3000  # frontend
http://localhost:8080  # api
http://localhost:5432  # db admin
```

You get:
```
http://frontend.localhost
http://api.localhost
http://db.localhost
```

## Architecture

```
                      ┌─────────────────────────────┐
                      │      localworld        │
                      │      (reverse proxy)        │
 *.localhost:3080 ───►│                             │
                      │  subdomain → port mapping   │
                      └──────────┬──────────────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             ▼                   ▼                   ▼
      localhost:3000      localhost:8080      localhost:5173
      (frontend)          (api)               (docs)
```

## Core Features

### 1. Subdomain Routing
- Route `<name>.localhost` → `localhost:<port>`
- Support for nested subdomains: `api.myproject.localhost`
- WebSocket support for HMR/live reload

### 2. Server Discovery
- Detect all TCP servers listening on localhost
- Identify the process and command that started each server
- Read environment variables from the process (e.g., `DOMAIN=foo`)

### 3. Mapping Strategies (in priority order)
1. **Explicit config**: User-defined mappings in `~/.localworld/config.yaml`
2. **Environment variable**: Process has `NAME=myapp` or `DOMAIN=myapp`
3. **Project detection**: Infer from package.json name, directory name, etc.
4. **Port-based fallback**: `p3000.localhost` → port 3000

### 4. Dashboard
- Web UI at `localworld.localhost` or `_.localhost`
- Shows all discovered servers
- Displays subdomain mappings
- Quick links to each service

---

## Research Findings (macOS)

### ✅ Finding servers and ports

```bash
lsof -i -P -n | grep LISTEN
```

Returns: process name, PID, port, protocol. Works perfectly.

### ✅ Getting command line from PID

```bash
ps -p <PID> -o command=
```

Returns full command with arguments. Can identify runtime (node, bun, python) and flags.

### ✅ Reading environment variables

```bash
ps -Eww -p <PID> -o command=
```

**Works for same-user processes.** Returns command + all env vars as space-separated string.

**Parsing caveat:** Env values can contain spaces. Naive space-split fails. Use regex:
```bash
perl -pe 's/ ([a-zA-Z_][a-zA-Z0-9_]*=)/\n$1/g'
```
This splits on ` KEY=` pattern to handle values with spaces.

### ❌ Methods that don't work on macOS

| Method | Status | Reason |
|--------|--------|--------|
| `lldb -p PID` | ❌ | Hangs, needs debug entitlements |
| `/proc/PID/environ` | ❌ | No procfs on macOS |
| `dtrace` | ❌ | Blocked by SIP |
| Other user's processes | ❌ | Permission denied |

### Useful environment variables for mapping

From `ps -Eww` we can extract:
- `PWD` — working directory
- `npm_package_name` — package name (set by npm/bun)
- `DIRENV_DIR` — project root (if using direnv)
- `npm_lifecycle_script` — the actual script being run
- Custom: `NAME` — explicit override

### Proof of Concept Output

```
┌─────────────────────────────────────────
│ :3000 → paper.localhost
├─────────────────────────────────────────
│ PID:     71626 (bun)
│ Command: bun run --watch src/server/index.ts
│ PWD:     /Users/slee2/projects/sleep-app/paper
│ Package: paper
└─────────────────────────────────────────

┌─────────────────────────────────────────
│ :3001 → muxtunnel.localhost
├─────────────────────────────────────────
│ PID:     48330 (node)
│ Command: node serve -p 3001 .
│ PWD:     /Users/slee2/projects/muxtunnel
│ Package: muxtunnel
└─────────────────────────────────────────
```

---

## Open Questions

### UX

1. **Conflict resolution**: What if two processes want the same subdomain?
   - First-come-first-served?
   - Prompt user?
   - Use project name + port as tiebreaker? (e.g., `paper-3000.localhost`)

2. **Multi-port projects**: Same project runs multiple servers (frontend + vite HMR)
   - Nested subdomains? `vite.paper.localhost`
   - Role detection from command? (vite → dev, serve → static)
   - Let user configure per-port names?

3. **Persistence**: Should mappings survive restarts?
   - Remember "last known" ports for projects?
   - Or always re-discover?

4. **Polling vs. Event-driven**:
   - How often to scan for new servers?
   - Scan on-demand when request comes in for unknown subdomain?

### Scope (deferred)

5. **Docker containers**: Route to Docker-exposed ports?
6. **Remote development**: Support SSH tunnels?

---

## Proposed Tech Stack

- **Language**: Node.js/TypeScript or Go
  - Node.js: Easier ecosystem, good http-proxy libs
  - Go: Better for system-level stuff, single binary

- **Reverse Proxy**:
  - Node: `http-proxy` or `fastify` with proxy plugin
  - Go: `httputil.ReverseProxy`

- **Process Inspection**:
  - Node: Native addon for libproc, or shell out to `ps`/`lsof`
  - Go: Native syscalls, easier cross-platform

- **Config**: YAML or TOML file in `~/.localworld/`

- **Dashboard**: Simple embedded web UI (vanilla or Preact)

---

## MVP Scope

### Phase 1: Manual Mapping
- [ ] Reverse proxy that reads from config file
- [ ] Route `subdomain.localhost` → configured port
- [ ] Dashboard showing current mappings

### Phase 2: Auto-Discovery
- [ ] Scan for listening ports on localhost
- [ ] Get process info (PID, command)
- [ ] Attempt to read environment variables
- [ ] Build automatic subdomain suggestions

### Phase 3: Smart Mapping
- [ ] Detect project type (Node, Python, Go, etc.)
- [ ] Read package.json, pyproject.toml, etc. for project name
- [ ] Watch for new servers starting/stopping
- [ ] Remember mappings across restarts

---

## Config File Example

```yaml
# ~/.localworld/config.yaml

# Explicit mappings (highest priority)
mappings:
  frontend: 3000
  api: 8080
  docs:
    port: 5173
    strip_prefix: false

# Environment variable to check for domain name
env_var: NAME

# Fallback to port-based subdomains (p3000.localhost)
port_subdomains: true

# Dashboard subdomain
dashboard: _  # accessible at _.localhost

# Port to listen on
listen_port: 3080
```

---

## Related/Prior Art

- **Hotel** (github.com/typicode/hotel): Similar concept, uses proxy
- **Puma-dev** (github.com/puma/puma-dev): For Ruby/Rack apps
- **Dnsmasq**: Can route *.localhost but no auto-discovery
- **Caddy**: Great reverse proxy, no auto-discovery
- **Traefik**: Docker-focused, overkill for local dev

---

## Next Steps

1. ~~Prototype port scanning + process inspection on macOS~~ ✅ Done
2. Build discovery module (TypeScript/Bun)
3. Build minimal reverse proxy
4. Wire discovery → proxy routing
5. Build dashboard
