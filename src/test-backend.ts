/**
 * Test backend for integration tests.
 * Handles HTTP (returns JSON with name/path/headers) and WebSocket (echo).
 * Supports PORT=0 for random port assignment.
 * Prints LISTENING:${port} to stdout for the test harness.
 */

const PORT = parseInt(process.env.PORT || "0", 10);
const NAME = process.env.NAME || "testapp";

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    const url = new URL(req.url);
    // /big?n=<bytes> — return a known repeating pattern of that size
    if (url.pathname === "/big") {
      const n = parseInt(url.searchParams.get("n") || "262144", 10);
      const chunk = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n";
      const body = chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n);
      return new Response(body, {
        headers: { "content-type": "text/plain" },
      });
    }
    return Response.json({
      name: NAME,
      path: url.pathname,
      headers: { host: req.headers.get("host") },
    });
  },
  websocket: {
    message(ws, message) {
      ws.send(message);
    },
  },
});

console.log(`LISTENING:${server.port}`);
