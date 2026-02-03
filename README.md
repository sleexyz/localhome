# localworld

A macOS daemon that routes `*.localhost:9999` to local services based on environment variables.

## The Problem

You're running multiple dev servers on different ports. You forget which port is which.

```
localhost:3000  # is this the frontend?
localhost:3001  # or is this one?
localhost:8080  # api? docs?
```

## The Solution

Set `NAME` when starting any server:

```bash
NAME=frontend bun run dev
NAME=api node server.js
NAME=docs python -m http.server
```

Access them at:

```
http://frontend.localhost:9999
http://api.localhost:9999
http://docs.localhost:9999
```

The daemon auto-discovers running servers and routes requests to the correct port.

## Install

```bash
# Clone and enter directory
cd ~/projects/localworld

# Allow direnv (loads nix flake with bun + just)
direnv allow

# Install the launchd service (runs on startup)
just install
```

## Usage

Start any server with `NAME`:

```bash
NAME=myapp bun run server.ts
# Now accessible at http://myapp.localhost:9999
```

View all running services at http://localhost:9999

## Commands

```bash
just run        # Run daemon in foreground
just dev        # Run with watch mode

just install    # Install launchd service
just start      # Start service
just stop       # Stop service
just restart    # Restart service
just status     # Check if running
just logs       # Tail stdout log
just errors     # Tail stderr log
just uninstall  # Remove service

just scan       # Debug: show discovered servers
just build      # Compile to binary
```

## Port Collision Tolerance

You don't need to coordinate ports across projects. Every project can default to `:3000` — it doesn't matter.

```bash
# Project A uses port 3000
cd ~/projects/frontend
NAME=frontend bun run dev  # starts on :3000

# Project B also wants port 3000? Just use a different one, who cares
cd ~/projects/api
NAME=api bun run dev  # starts on :3001

# Access by name, not port
http://frontend.localhost:9999  # → :3000
http://api.localhost:9999       # → :3001
```

The port is an implementation detail. You never need to remember it.

## How It Works

1. Daemon listens on port 9999
2. On each request, scans for processes with `NAME` env var
3. Matches subdomain to process, finds its listening port
4. Proxies the request

```
Request: frontend.localhost:9999
    ↓
Daemon finds process with NAME=frontend
    ↓
That process is listening on :3000
    ↓
Proxy request to localhost:3000
```

## Configuration

The daemon uses sensible defaults. No config file needed.

| Setting | Default | Description |
|---------|---------|-------------|
| Port | 9999 | Set via `PORT` env var |
| Cache TTL | 5s | How often to re-scan for servers |

## Requirements

- macOS (uses `lsof` and `ps -Eww` for process inspection)
- Bun runtime
- Modern browser (Chrome/Firefox/Safari resolve `*.localhost` automatically)
