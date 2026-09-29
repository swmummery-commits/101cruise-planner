#!/bin/bash
# Status + health of the Princess Mac source worker.
set -euo pipefail
LABEL="au.com.101cruise.princess-source-worker"
HEARTBEAT="${PRINCESS_SOURCE_WORKER_HEARTBEAT_PATH:-$HOME/Library/Logs/101cruise-princess-source-worker-heartbeat.json}"
echo "label: $LABEL"
launchctl list | awk -v label="$LABEL" '$3==label { print "pid_exit_label: " $0 }'
if [[ -f "$HEARTBEAT" ]]; then
  echo "heartbeat_file: $HEARTBEAT"
  cat "$HEARTBEAT"
else
  echo "heartbeat_file: missing"
fi
