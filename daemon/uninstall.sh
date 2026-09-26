#!/bin/bash
echo "This will remove MEMentum Daemon and delete all configuration in ~/.mementum"
echo "Type 'yes' to confirm:"
read confirmation
if [ "$confirmation" != "yes" ]; then
    echo "Uninstall cancelled."
    exit 0
fi

echo "Uninstalling MEMentum Daemon..."

# Remove LaunchAgent if it was installed by a previous version
launchctl stop com.mementum.daemon 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.mementum.daemon.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.mementum.daemon.plist"

# Remove binary and config
rm -f "$HOME/.local/bin/mementum-daemon"
rm -rf "$HOME/.mementum"

echo "MEMentum Daemon uninstalled."
