#!/bin/bash
# Install the Princess Mac source worker as a per-user launchd agent.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="au.com.101cruise.princess-source-worker"
PLIST_SRC="$REPO_ROOT/scripts/macos/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|REPO_ROOT|$REPO_ROOT|g" -e "s|/usr/local/bin/node|$NODE_BIN|g" -e "s|HOME|$HOME|g" "$PLIST_SRC" > "$DEST"
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
launchctl start "$LABEL" 2>/dev/null || true
echo "installed $DEST"
echo "node $NODE_BIN"
echo "use: $REPO_ROOT/scripts/macos/princess-source-worker-status.sh"
