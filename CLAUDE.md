# localhome

TCP-level proxy that routes `*.localhost` subdomains to local services discovered via `lsof`+`ps` (looking for `NAME` env var).

## Running

```
just dev          # run with watch mode
just test         # bun test
just scan         # debug: show discovered services
```

Default port: 9090 (configurable via `PORT` env).

## Architecture

- `src/index.ts` — Main daemon. `Bun.listen` for TCP-level proxying. HTTP proxied via `fetch()`, WebSocket/CONNECT via raw TCP pipe (`Bun.connect`).
- `src/scan.ts` — Service discovery via `lsof -i -P -n` + `ps -Eww` to find processes with `NAME` env var.
- `src/test-backend.ts` — Test HTTP+WS server. Returns JSON `{name, path, headers}` and echoes WebSocket messages.
- `src/index.test.ts` — Integration tests using raw TCP sockets (`net.connect`), no HTTP/WS libraries.
- Mapping cache: 5s TTL, lazy scan.

## Proxy Modes

1. **Reverse proxy** — `testapp.localhost:9090` routes to the local process with `NAME=testapp`.
2. **Forward proxy** — Absolute URI (`GET http://testapp/`) via PAC file. Requires Host header rewriting to `localhost:<port>` so backends (Vite, Next.js, etc.) don't reject with 403.
3. **CONNECT tunnel** — For WebSocket/HTTPS through forward proxy. Returns `200 Connection Established`, then pipes TCP bidirectionally.

## Testing Gotchas

- **Bun test runner kills child processes**: Spawned processes get killed as "dangling". Workaround: `sh -c "exec ..."` with `detached: true` + `unref()`.
- **Port discovery**: Daemon and test backend print `LISTENING:${port}` to stdout. Test harness reads this for random ports.
- **Mapping cache race**: First request to a new backend may 404 (lsof hasn't scanned yet). Use `retryRequest()` with delay.
- `Bun.listen({ port: 0 })` and `Bun.serve({ port: 0 })` return the actual assigned port.

## Networking Constraints

- Always rewrite Host header for proxied requests — upstream dev servers reject unexpected Host values.
- Strip conditional headers (`If-None-Match`, `If-Modified-Since`) to avoid 304 loops through the proxy.
- Use `redirect: "manual"` in fetch to forward redirects as-is rather than following them.
- For unknown forward proxy targets, close the connection without a response so the PAC `DIRECT` fallback kicks in.
