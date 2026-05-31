// Must match the daemon's `port` (see Configuration in the README).
// Bare-name requests like `app/` are proxied to `app.localhost:<PORT>`.
const PORT = 80;

chrome.runtime.onInstalled.addListener(() => {
  chrome.proxy.settings.set({
    value: {
      mode: "pac_script",
      pacScript: {
        data: [
          "function FindProxyForURL(url, host) {",
          '  if (host.indexOf(".") === -1 && host !== "localhost") {',
          `    return "PROXY " + host + ".localhost:${PORT}; DIRECT";`,
          "  }",
          '  return "DIRECT";',
          "}",
        ].join("\n"),
      },
    },
    scope: "regular",
  });
});
