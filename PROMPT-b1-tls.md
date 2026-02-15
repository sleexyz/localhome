# B1 TLS: Inline socket.upgradeTLS()

## Context

**Goal:** Replace the internal-loopback TLS architecture (B2) with inline `socket.upgradeTLS()` (B1) for HTTPS MITM in localhome's forward proxy.

**Why it matters:** The current B2 architecture creates a bridge socket + internal TLS listener per CONNECT tunnel. This adds 3 socket pairs per request, duplicates HTTP parsing logic, and causes `ERR_CONNECTION_RESET` / `ERR_EMPTY_RESPONSE` under real browser load (concurrent connections, keep-alive). B1 eliminates the bridge entirely — one socket, TLS upgraded in-place.

**Risk:** Bun issue #22570 reported SIGSEGV with concurrent `upgradeTLS()` calls. This experiment validates whether that bug affects us. If the daemon crashes under load, B1 is dead and we fall back to B4.

### Architecture: Before (B2) vs After (B1)

**B2 (current):**
```
Browser ──CONNECT──▶ main socket ──200──▶ Browser
Browser ──TLS bytes──▶ main socket ──pipe──▶ bridge socket ──▶ TLS listener
                                              TLS terminated
                                              manually parse HTTP
                                              fetch() to backend
```
3 socket pairs. Bridge piping. Duplicated HTTP parsing.

**B1 (target):**
```
Browser ──CONNECT──▶ socket ──200──▶ Browser
                     socket.upgradeTLS()
Browser ◀──TLS─────▶ socket (same one, decrypted)
                     parse HTTP, fetch()/proxyWebSocket() to backend
```
1 socket pair. No bridge. No duplicated logic.

### Key files

- `src/index.ts` — Main daemon. CONNECT handler needs rewrite. Remove `tlsListeners` map and `getOrCreateTlsListener()`.
- `src/proxy.ts` — Shared proxy utilities. Already has `proxyHttpRequest()` and `proxyWebSocket()` — reuse these.
- `src/certs.ts` — Certificate generation. `getCert(hostname)` returns `{ cert, key }`. No changes needed.
- `src/index.test.ts` — Integration tests. Existing HTTPS MITM tests should pass unchanged.
- `src/test-backend.ts` — Test HTTP+WS server. No changes needed.

### Bun upgradeTLS API

Research this first. The API signature is likely:
```ts
socket.upgradeTLS(options) → Socket | Promise<Socket>
```
Check Bun docs/source for: return type, whether the original socket handlers still fire, whether you need to set new handlers, the `data` property on the upgraded socket.

---

## State

**Progress:** BLOCKED — `upgradeTLS()` does not support server-side sockets

**Current understanding:**
- `socket.upgradeTLS()` exists but **only works on client-side sockets** (from `Bun.connect()`)
- Server-side sockets (from `Bun.listen()`) — which is what our CONNECT handler receives — **crash or throw errors**
- This is not a bug that will be fixed soon — it's a fundamental limitation in uSockets' shared `us_socket_context_t` architecture
- Bun issue #25044 (master tracker) is OPEN with no timeline
- B1 architecture is impossible with current Bun. Must fall back to B4 (Bun.serve per-hostname)

**Last iteration:** Research completed, B1 declared blocked

---

## Predictions

- [ ] `socket.upgradeTLS()` API exists in Bun and works for server-side sockets from `Bun.listen`
- [ ] It will NOT crash under the concurrency level of a single browser tab (5-10 concurrent CONNECT tunnels)
- [ ] The upgraded socket delivers decrypted data through a `data` callback — we won't need a separate listener
- [ ] Removing the bridge eliminates the `ERR_CONNECTION_RESET` / `ERR_EMPTY_RESPONSE` errors
- [ ] The hardest part will be understanding the `upgradeTLS()` API contract, not the architectural changes

---

## Prediction Outcomes

1. **API exists and works for server-side sockets**: ✗ WRONG — The API exists (`socket.upgradeTLS(options) → [raw, tls]`) but **only works on client-side sockets** from `Bun.connect()`. Server-side sockets from `Bun.listen()` crash (SIGSEGV) or throw `"Server-side upgradeTLS is not supported"`. This is tracked as Bun issue #25044 (open, no timeline).

2. **Won't crash under concurrency**: N/A — Crashes even with a single server-side upgrade call. The SIGSEGV in #22570 was caused by this same root issue, not a concurrency bug.

3. **Decrypted data through callback**: ✓ CORRECT (for client sockets) — `upgradeTLS()` returns `[raw, tls]` where the `tls` socket's `data` handler receives plaintext. The `raw` socket's handler receives ciphertext.

4. **Removing bridge eliminates errors**: N/A — Can't test because the upgrade itself doesn't work.

5. **Hardest part is understanding the API**: ✓ CORRECT — The understanding revealed B1 is impossible, saving significant implementation time.

---

## Discoveries

### `upgradeTLS()` API details (for future reference)

```ts
// Signature (client-side only)
socket.upgradeTLS<Data>(options: {
  data?: Data;           // sets socket.data on the TLS socket
  tls: TLSOptions;       // cert, key, ca, etc.
  socket: SocketHandler; // NEW handlers for decrypted data
}) → [raw: Socket<Data>, tls: Socket<Data>]
```

- `raw` socket: receives encrypted ciphertext via its original `data` handler
- `tls` socket: receives decrypted plaintext via the NEW `data` handler from `options.socket`
- `handshake(socket, success, authorizationError)` callback available on the new handlers

### Why server-side doesn't work

uSockets (the C library underneath Bun's networking) uses a shared `us_socket_context_t` for all sockets accepted by a listener. `upgradeTLS` needs to swap this context for an SSL context, but:
- The context is shared between sockets — can't swap one without affecting others
- There's no API to check if a context is already SSL
- The shared state leads to corruption and SIGSEGV on second upgrade

Bun PR #25043 (open) adds an explicit error: `"Server-side upgradeTLS is not supported"`.

### Implications for localhome

B1 (inline `upgradeTLS()`) is dead. Alternatives:
- **B2 (current)**: Bridge socket to internal `Bun.listen({ tls })`. Works but brittle under load.
- **B4**: `Bun.serve({ tls })` per hostname. Uses Bun's HTTP server for TLS termination instead of raw `Bun.listen`. May be more stable under concurrent connections since `Bun.serve` is battle-tested.
- **Node.js TLS**: Use `node:tls` `TLSSocket` wrapper on the raw socket. Bun supports Node compatibility — this might work where `upgradeTLS` fails.

---

## Tasks

### Current Focus

- [x] Research Bun's `socket.upgradeTLS()` API — **RESULT: Does not work on server-side sockets. B1 is blocked.**

### Blocked — All remaining tasks cancelled

- ~~Remove B2 architecture~~ — N/A, B1 impossible
- ~~Implement B1 in CONNECT handler~~ — N/A
- ~~Rewrite Host + Origin headers~~ — N/A
- ~~Run tests~~ — N/A
- ~~Concurrent HTTPS test~~ — N/A

### Next step

- [ ] Create PROMPT-b4-tls.md for the `Bun.serve({ tls })` fallback approach
- [ ] Consider node:tls TLSSocket as alternative B5 approach

---

## Instructions

1. **Read context** — This file, `CLAUDE.md`, `progress-b1-tls.txt` if it exists
2. **Pick the most important unchecked task** (not necessarily in order — research first!)
3. **Implement it fully** — no placeholders, tests for critical behavior
4. **Run and verify** — pipe long-running commands through `tee -a bashes.log`
5. **Update** — Check off tasks, update State section
6. **Commit** — `git add -A && git commit -m "feat: <description>"`

---

## Success Criteria

- `socket.upgradeTLS()` works without crashing
- All existing tests pass
- Concurrent HTTPS connections test passes
- `getOrCreateTlsListener` and `tlsListeners` are gone from the codebase
- The CONNECT :443 handler is simpler than before

---

## Termination

When all tasks complete OR blocked:
- All done: `<promise>COMPLETE</promise>`
- Blocked (e.g. SIGSEGV): `<promise>BLOCKED</promise>` — document the crash, what was tried, and what B4 would look like

---

## If Stuck

1. Reframe: What question are you actually trying to answer?
2. Check Bun GitHub issues for `upgradeTLS` — has #22570 been fixed? Are there newer issues?
3. Try a minimal repro: standalone script with `Bun.listen` + `upgradeTLS` under concurrent connections
4. If truly stuck: `<promise>BLOCKED</promise>`
