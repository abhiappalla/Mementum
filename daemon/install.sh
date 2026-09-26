#!/bin/bash
# MEMentum Daemon Installer
# Installs only the binary. The daemon is session-scoped — it is launched and
# stopped by the MEMentum UI app, not by launchd.

set -e

DAEMON_BINARY="./target/release/mementum-daemon"
INSTALL_DIR="$HOME/.local/bin"

if [[ ! -f "$DAEMON_BINARY" ]]; then
    echo "Release binary not found — building..."
    cargo build --release
fi

echo "Installing MEMentum Daemon..."

mkdir -p "$INSTALL_DIR"

cp "$DAEMON_BINARY" "$INSTALL_DIR/mementum-daemon"
chmod +x "$INSTALL_DIR/mementum-daemon"

echo ""
echo "MEMentum Daemon installed to $INSTALL_DIR/mementum-daemon"
echo ""
echo "Launch the MEMentum app to start it."
echo "The daemon runs only while the app is open and exits cleanly when the app quits."
echo ""
echo "API token:   cat ~/.mementum/api_token  (created on first run)"
echo "Uninstall:   ./uninstall.sh"
