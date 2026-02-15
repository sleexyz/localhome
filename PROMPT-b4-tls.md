# B4 TLS: Bun.serve({ tls }) per hostname

## Context

**Goal:** Replace the internal-loopback TLS architecture (B2: `Bun.listen({ tls })` with manual HTTP parsing) with `Bun.serve({ tls })` per hostname for HTTPS MITM in localhome's forward proxy.

**Why it matters:** B2 works for single requests but fails under real browser load (`ERR_CONNECTION_RESET`, `ERR_EMPTY_RESPONSE`). Root cause: the TLS listener manually re-implements HTTP parsing and closes the socket after one response (breaking keep-alive). `Bun.serve` handles HTTP parsing, keep-alive, chunked encoding, WebSocket upgrades, and backpressure natively — eliminating the entire class of manual-parsing bugs.

**Prior art:** B1 (`socket.upgradeTLS()`) was proven impossible — server-side sockets from `Bun.listen` can't be upgraded to TLS due to uSockets' shared `us_socket_context_t`. See PROMPT-b1-tls.md for details.

### Architecture

The bridge (piping bytes between browser socket and internal server) is identical to B2. The difference is what sits behind the bridge.

**B2 (current — broken under load):**
```
Browser ──TLS bytes──▶ main socket ──bridge──▶ Bun.listen({ tls })
                                                Manual HTTP parsing in data() handler
                                                Manual WebSocket detection
                                                proxyHttpRequest() → writeAllAndEnd() → socket closed
                                                ❌ Keep-alive broken, duplicated logic
```

**B4 (target):**
```
Browser ──TLS bytes──▶ main socket ──bridge──▶ Bun.serve({ tls })
                                                Native HTTP parsing
                                                Native WebSocket via server.upgrade()
                                                fetch() handler returns Response
                                                ✓ Keep-alive, chunked, backpressure all native
```

### Key insight

The bridge is not the bug. The bridge is just `socket.write(data)` in both directions — it's trivial byte forwarding. The bugs come from what happens AFTER TLS termination: our hand-rolled HTTP handling in the `Bun.listen` socket data handler. `Bun.serve` replaces all of that with Bun's native, battle-tested HTTP server.

### Key files

- `src/index.ts` — Rewrite `getOrCreateTlsListener()` to use `Bun.serve({ tls })` instead of `Bun.listen({ tls })`. The CONNECT handler and bridge stay the same.
- `src/proxy.ts` — `proxyHttpRequest()` and `proxyWebSocket()` are for raw sockets. Bun.serve's `fetch()` handler doesn't need them — it works with `Request`/`Response` objects directly. May still use `proxyWebSocket`-style logic for WS proxying.
- `src/certs.ts` — No changes. `getCert(hostname)` returns `{ cert, key }`.
- `src/index.test.ts` — Existing tests should pass unchanged. Add concurrent connections test.

---

## State

**Progress:** COMPLETE

**Current understanding:**
- B2's bugs are from manual HTTP handling, not from the bridge
- `Bun.serve({ tls })` is the most battle-tested TLS code path in Bun
- The bridge (byte piping) is shared between B2 and B4 — only the TLS server changes
- We need to handle: HTTP proxying, WebSocket proxying, self-referential dashboard, PAC file

**Last iteration:** All tasks complete, 24/24 tests pass

---

## Predictions

- [x] `Bun.serve({ tls, port: 0 })` behind a bridge socket will work for basic HTTP requests on the first try
- [x] Keep-alive will work naturally — multiple requests per CONNECT tunnel without reconnecting
- [x] WebSocket proxying through Bun.serve will require using Bun's WebSocket client on the backend side, not raw TCP piping
- [x] The concurrent connection errors (`ERR_CONNECTION_RESET`, `ERR_EMPTY_RESPONSE`) will be eliminated
- [ ] The total code in `getOrCreateTlsListener` will be shorter with Bun.serve than with Bun.listen, despite adding a fetch handler and WebSocket handler

---

## Prediction Outcomes

1. **Bun.serve behind bridge works on first try**: ✓ CORRECT — Spike passed immediately once data buffering was handled (backend connect is async, TLS ClientHello can arrive before bridge is ready).
2. **Keep-alive works naturally**: ✓ CORRECT — Test sends 3 HTTP requests on one TLS connection, all succeed. B2 would have failed after the first response.
3. **WebSocket needs Bun's WebSocket client**: ✓ CORRECT — Used `new WebSocket()` in the `websocket.open` handler to connect to the backend, piping messages bidirectionally. Needed to buffer messages until `backendWs.open` fires.
4. **Concurrent connection errors eliminated**: ✓ CORRECT — 5 simultaneous CONNECT+TLS tunnels all succeed. This was the core regression test for B2's failures.
5. **Shorter code**: ✗ WRONG — The code is slightly longer because the fetch handler includes dashboard HTML rendering (duplicated from the main listener's `renderDashboard()`). However, it's *much simpler* — no manual HTTP parsing, no `writeAllAndEnd`, no drain/backpressure handling, no socket state machine.

---

## Discoveries

### Bridge buffering is required
When a client connects to the bridge (plain TCP listener), the `open` handler fires `Bun.connect()` to the internal TLS server. This is async. The TLS ClientHello bytes from the client can arrive via the `data` handler before the backend connection is established. Solution: buffer incoming data in `pendingToBackend[]` and flush on backend `open`. In production, the CONNECT handler sends `200 Connection Established` in the bridge's `onOpen`, so the browser only starts TLS after the bridge is connected — no buffering needed there.

### WebSocket message buffering
`new WebSocket()` is async — the `open` event fires after the WS handshake completes. But Bun.serve's `websocket.message` handler can fire immediately when the browser sends a WS frame. Must buffer messages in `pendingMessages[]` and flush on `backendWs.open`.

### Bun.serve handles all the hard parts
No manual HTTP parsing, no backpressure handling, no keep-alive management, no chunked transfer encoding. The `fetch()` handler receives a `Request` and returns a `Response` — Bun handles serialization, content-length, connection management, etc.

### WebSocket proxying via `new WebSocket()` with custom headers
Bun's `WebSocket` constructor accepts a second options argument with `headers` — used to set `host` and `origin` for the backend connection. This replaces the raw TCP piping approach from B2.

---

## Tasks

### Spike (do this first — validate before building)

- [x] Create a minimal spike: `Bun.serve({ tls, port: 0 })` on 127.0.0.1 with a hardcoded cert. Bridge a CONNECT tunnel to it. Send one HTTPS request through. Verify the response arrives. This is the 10-minute proof-of-concept — if this doesn't work, stop.

### Build

- [x] Rewrite `getOrCreateTlsListener()` — replace `Bun.listen({ tls })` with `Bun.serve({ tls, port: 0 })`. The returned port is used the same way (bridge connects to it).
- [x] Implement the `fetch()` handler — look up backend port for the hostname, rewrite Host header, `fetch()` to backend, return Response. Handle self-referential targets (serve dashboard HTML). Handle `/proxy.pac`. Strip hop-by-hop headers and `content-encoding` (fetch auto-decompresses).
- [x] Implement WebSocket proxying — in `fetch()`, detect upgrade, call `server.upgrade(req, { data: { hostname, targetPort } })`. In the `websocket` handler, connect to backend via `new WebSocket()` client, pipe messages bidirectionally. Rewrite Host + Origin on the backend connection.
- [x] Clean up — removed all B2 manual HTTP parsing code from the TLS listener. The `Bun.serve` fetch handler replaces all of it.

### Verify

- [x] `bun test` — all 22 existing tests pass
- [x] Concurrent HTTPS test — 5 simultaneous `CONNECT testapp:443` tunnels, all succeed
- [x] WebSocket over TLS still works (existing test passes)
- [x] Self-referential HTTPS: `CONNECT _testhome:443` serves dashboard over TLS
- [x] Keep-alive test — 3 HTTP requests through a single CONNECT+TLS tunnel, all succeed
- [ ] Manual browser test: use `--chrome` flag or manually navigate to `https://testapp/` through the proxy. Verify page loads with all subresources (CSS, JS, images). This is the real-world validation.

### Later

- [ ] If B4 works in tests but still has browser issues, add `--chrome` for visual verification
- [ ] Consider whether B2 code can be fully removed or if any edge cases need it

---

## Instructions

1. **Read context** — This file, `CLAUDE.md`, `PROMPT-b1-tls.md` (for discoveries), `progress-b4-tls.txt` if it exists
2. **Spike first** — Don't build until the spike proves Bun.serve behind a bridge works
3. **Pick the most important unchecked task** (not necessarily in order)
4. **Implement it fully** — no placeholders, tests for critical behavior
5. **Run and verify** — pipe long-running commands through `tee -a bashes.log`
6. **Update** — Check off tasks, update State section
7. **Commit** — `git add -A && git commit -m "feat: <description>"`

---

## Success Criteria

- All existing tests pass
- Concurrent HTTPS connections test passes (5+ simultaneous tunnels)
- `getOrCreateTlsListener` uses `Bun.serve({ tls })` instead of `Bun.listen({ tls })`
- No manual HTTP parsing in the TLS layer — Bun.serve handles it
- WebSocket over TLS works
- Self-referential dashboard works over TLS

---

## Termination

When all tasks complete OR blocked:
- All done: `<promise>COMPLETE</promise>`
- Blocked: `<promise>BLOCKED</promise>` — document what failed and why

---

## If Stuck

1. Check if the bridge is the problem (add logging to bridge data handlers — are bytes flowing?)
2. Check if Bun.serve is the problem (connect directly to the internal server without the bridge — does it work?)
3. If WebSocket proxying is hard, consider using raw TCP piping for WS (like B2) while using Bun.serve for HTTP only
4. If truly stuck: `<promise>BLOCKED</promise>`
