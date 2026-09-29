#!/bin/bash
# Uninstall the Princess Mac source worker launchd agent.
set -euo pipefail
LABEL="au.com.101cruise.princess-source-worker"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "uninstalled $LABEL"
