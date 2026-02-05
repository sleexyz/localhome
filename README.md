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

## Commands

```bash
just run        # Run daemon in foreground
just dev        # Run with watch mode
just install    # Install launchd service
just start      # Start service
just stop       # Stop service
just restart    # Restart service
just logs       # Tail logs
just scan       # Show discovered servers
```

## Requirements

- macOS
- Bun
- Chrome (for bare hostname routing via extension)
