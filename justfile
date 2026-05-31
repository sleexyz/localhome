# launchd service label (override: just LABEL=com.you.localhome install)
service := env_var_or_default("LABEL", "com.localhome")
plist := "~/Library/LaunchAgents/" + service + ".plist"
# NAME the daemon registers itself under (its dashboard route)
name := env_var_or_default("NAME", "home")
repo := justfile_directory()
rendered := repo / "launchd" / service + ".local.plist"

# Show all commands
[private]
default:
    @just --list

# Run the daemon
[group('dev')]
run:
    NAME={{name}} bun run src/index.ts

# Run with watch mode
[group('dev')]
dev:
    NAME={{name}} bun run --watch src/index.ts

# Run tests
[group('test')]
test:
    bun test

# Scan for running servers (debug)
[group('debug')]
scan:
    bun run src/scan.ts

# Run a test server (use LOCALHOST_NAME=foo just test-server)
[group('debug')]
test-server:
    bun run src/test-server.ts

# Build binary
[group('build')]
build:
    bun build src/index.ts --compile --outfile bin/localhome

# Render the launchd plist from the template for this machine (gitignored output)
[group('service')]
render:
    #!/usr/bin/env bash
    set -euo pipefail
    bun_path="$(command -v bun)"
    path_dir="$(dirname "$bun_path")"
    sed \
      -e "s#@LABEL@#{{service}}#g" \
      -e "s#@BUN@#${bun_path}#g" \
      -e "s#@REPO@#{{repo}}#g" \
      -e "s#@HOME@#${HOME}#g" \
      -e "s#@NAME@#{{name}}#g" \
      -e "s#@PATH@#${path_dir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin#g" \
      "{{repo}}/launchd/com.localhome.plist.template" > "{{rendered}}"
    echo "Rendered {{rendered}}"

# Start the service
[group('service')]
start:
    launchctl bootstrap gui/$(id -u) {{plist}}

# Stop the service
[group('service')]
stop:
    launchctl bootout gui/$(id -u)/{{service}}

# Restart the service
[group('service')]
restart:
    launchctl kickstart -k gui/$(id -u)/{{service}}

# Show service status
[group('service')]
status:
    @launchctl list | grep {{service}} || echo "Service not loaded"
    @echo "---"
    @lsof -i :9090 2>/dev/null || echo "Port 9090 not listening"

# View logs
[group('service')]
logs:
    tail -f ~/Library/Logs/localhome.log

# View error logs
[group('service')]
errors:
    tail -f ~/Library/Logs/localhome.error.log

# Render + install/reinstall the plist (generates from template, then loads it)
[group('service')]
install: render
    cp {{rendered}} {{plist}}
    launchctl bootout gui/$(id -u)/{{service}} 2>/dev/null || true
    launchctl bootstrap gui/$(id -u) {{plist}}
    @echo "Installed and started. Check: just status"

# Uninstall the service completely
[group('service')]
uninstall:
    launchctl bootout gui/$(id -u)/{{service}} 2>/dev/null || true
    rm -f {{plist}}
    @echo "Service uninstalled. Logs remain at ~/Library/Logs/localhome*.log"
