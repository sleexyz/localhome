# How localhome works

localhome is a TCP-level proxy that gives your local dev servers pretty URLs. Instead of remembering `localhost:5173` and `localhost:3001`, you visit `frontend.localhost:9090` and `api.localhost:9090`. It discovers services automatically — no config files.

## Service discovery

localhome finds services by combining two system commands:

1. **`lsof -i -P -n`** — lists all processes with open network connections, filtered to `LISTEN` state. This gives us a map of PID → listening ports.

2. **`ps -Eww -p <pid>`** — for each listening PID, reads the full environment. localhome looks for a `NAME` env var. If a process was started with `NAME=myapp`, it becomes routable at `myapp.localhost`.

Results are grouped by `NAME`. A single service may have multiple PIDs (e.g. a parent and worker) or multiple ports (app port, debug port, HMR port). The port selection heuristic picks the right one.

## Port selection heuristic

When a service exposes multiple ports, localhome applies a filter pipeline to pick the primary one:

1. **Remove debug ports** — 9229 (Node inspector), 9222 (Chrome DevTools Protocol), 5858 (legacy Node debug)
2. **Remove ephemeral ports** — anything >= 49152 (OS-assigned ports for HMR, WebSocket dev channels, etc.)
3. **Pick the lowest surviving port** — conventionally the main application port
4. **Fallback** — if nothing survives the filters, use the lowest port from the original set

## Proxy modes

localhome operates at the TCP level (`Bun.listen`) and supports three modes:

### Reverse proxy (subdomain)

`myapp.localhost:9090` → `localhost:<port>`

The browser connects directly using the `.localhost` subdomain. localhome extracts the subdomain from the `Host` header, looks up the port, and proxies the request via `fetch()`. The `Host` header is preserved as-is for reverse proxy mode.

### Forward proxy (absolute URI)

Via a PAC file (`http://localhost:9090/proxy.pac`), the browser sends requests like `GET http://myapp/ HTTP/1.1` to localhome. This lets you use bare hostnames (`http://myapp/`) without the `.localhost` suffix.

localhome rewrites the absolute URI to a relative path and sets the `Host` header to `localhost:<port>` so backend dev servers (Vite, Next.js, etc.) don't reject the request with a 403.

For unknown hostnames, localhome closes the connection without responding, which triggers the PAC file's `DIRECT` fallback so normal internet traffic isn't affected.

### CONNECT tunnel

For WebSocket and HTTPS through the forward proxy, browsers send a `CONNECT myapp:80` request. localhome responds with `200 Connection Established` and then pipes TCP bidirectionally between the browser and the backend. This is a raw byte stream — localhome doesn't inspect or modify the tunneled traffic.

## Caching

The service mapping is cached for 5 seconds. The first request after cache expiry triggers a fresh `lsof` + `ps` scan. This keeps the proxy responsive while picking up new services within a few seconds of launch.

## PAC file

The auto-configuration file at `/proxy.pac` tells browsers:

```javascript
function FindProxyForURL(url, host) {
  if (host.indexOf(".") === -1 && host !== "localhost") {
    return "PROXY " + host + ".localhost:9090; DIRECT";
  }
  return "DIRECT";
}
```

Any bare hostname (no dots, not `localhost` itself) gets routed through localhome. Everything else goes direct. The `; DIRECT` fallback ensures that if localhome doesn't recognize a name, the browser falls back to normal DNS resolution.
