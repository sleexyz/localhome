const PORT = 9090;

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
