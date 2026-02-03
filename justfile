# launchd service name
service := "com.slee2.localworld"
plist := "~/Library/LaunchAgents/" + service + ".plist"

# Show all commands
[private]
default:
    @just --list

# Run the daemon
[group('dev')]
run:
    bun run src/index.ts

# Run with watch mode
[group('dev')]
dev:
    bun run --watch src/index.ts

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
    bun build src/index.ts --compile --outfile bin/localworld

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
    @lsof -i :9999 2>/dev/null || echo "Port 9999 not listening"

# View logs
[group('service')]
logs:
    tail -f ~/Library/Logs/localworld.log

# View error logs
[group('service')]
errors:
    tail -f ~/Library/Logs/localworld.error.log

# Install/reinstall the plist (copies from repo)
[group('service')]
install:
    cp launchd/com.slee2.localworld.plist {{plist}}
    launchctl bootout gui/$(id -u)/{{service}} 2>/dev/null || true
    launchctl bootstrap gui/$(id -u) {{plist}}
    @echo "Installed and started. Check: just status"

# Uninstall the service completely
[group('service')]
uninstall:
    launchctl bootout gui/$(id -u)/{{service}} 2>/dev/null || true
    rm -f {{plist}}
    @echo "Service uninstalled. Logs remain at ~/Library/Logs/localworld*.log"
