# localhostess

A macOS daemon that routes `*.localhost:9999` to local services based on environment variables.

## The Goal

Any application can start a server with:

```bash
NAME=paper node server.js
# or
NAME=api bun run dev
```

And it becomes accessible at:

```
http://paper.localhost:9999
http://api.localhost:9999
```

No matter what port the service actually binds to.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                   localhostess                      │
│                   (daemon on :9999)                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Scans running processes for NAME=xxx      │
│  2. Finds what port each process is listening on        │
│  3. Routes xxx.localhost:9999 → localhost:<port>        │
│                                                         │
└─────────────────────────────────────────────────────────┘

Request flow:
  paper.localhost:9999 → daemon → localhost:3000 (where paper actually runs)
  api.localhost:9999   → daemon → localhost:8080 (where api actually runs)
```

## Core Contract

- **Env var**: `NAME=<subdomain>`
- **Daemon port**: `9999` (configurable)
- **Routing**: `<subdomain>.localhost:9999` → process's actual port

## Open Questions

### When to compute/recompute the mapping?

Options:

1. **Polling interval** (e.g., every 5s)
   - Simple to implement
   - Slight delay for new services to appear
   - Continuous CPU usage (minimal)

2. **On-demand (lazy)**
   - Scan only when a request comes in for an unknown subdomain
   - Zero overhead when idle
   - First request to new service has latency spike

3. **Hybrid**
   - Cache mappings with TTL
   - Re-scan on cache miss
   - Best of both worlds?

4. **File-based trigger**
   - Watch a file/socket for "refresh" signals
   - Services could notify daemon when they start
   - More complex, requires cooperation from services

5. **Process monitoring (kqueue)**
   - macOS kqueue can watch for process events
   - Get notified when processes start/exit
   - Most efficient but complex to implement

### Other questions

- **Conflict resolution**: Two processes with same `NAME`?
  - First one wins? Last one wins? Error?

- **Process exit**: How quickly to detect and remove stale mappings?

- **Dashboard**: Show current mappings at `_.localhost:9999` or `localhost:9999`?

- **Fallback**: What if no `NAME`? Ignore? Use `npm_package_name`? Use directory name?

## Non-Goals (for now)

- HTTPS support
- Port 80 binding
- Linux support
- Docker container routing
- Remote/SSH tunnel support

## Success Criteria

```bash
# Terminal 1: Start the daemon
localhostess

# Terminal 2: Start a service
NAME=myapp node -e "require('http').createServer((req,res) => res.end('hello')).listen(4567)"

# Terminal 3: Access it
curl http://myapp.localhost:9999
# => hello
```
