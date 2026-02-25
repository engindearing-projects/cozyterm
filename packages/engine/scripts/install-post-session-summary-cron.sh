#!/bin/bash
set -euo pipefail

# Install a launchd job to run post-session-summary.mjs on a schedule.
#
# Usage:
#   ./scripts/install-post-session-summary-cron.sh <repo_path> [interval_seconds]
#   ./scripts/install-post-session-summary-cron.sh uninstall

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/config/logs"
LABEL="com.cozyterm.post-session-summary"

ACTION="${1:-install}"

if [[ "$ACTION" == "uninstall" ]]; then
  PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [[ -f "$PLIST_DEST" ]]; then
    echo "Stopping and removing launchd job..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "Done."
  else
    echo "Job not installed."
  fi
  exit 0
fi

REPO_PATH="${1:-}"
INTERVAL="${2:-1800}"

if [[ -z "$REPO_PATH" ]]; then
  echo "Usage: $0 <repo_path> [interval_seconds]"
  exit 1
fi

if [[ ! -d "$REPO_PATH" ]]; then
  echo "Error: repo path does not exist: $REPO_PATH"
  exit 1
fi

mkdir -p "$LOG_DIR"

PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -f "$PLIST_SRC" ]]; then
  echo "Error: missing plist template $PLIST_SRC"
  exit 1
fi

echo "Installing launchd job..."
cp "$PLIST_SRC" "$PLIST_DEST"

sed -i '' "s|COZYTERM_SCRIPTS_DIR|$SCRIPT_DIR|g" "$PLIST_DEST"
sed -i '' "s|COZYTERM_LOG_DIR|$LOG_DIR|g" "$PLIST_DEST"
sed -i '' "s|REPO_PATH|$REPO_PATH|g" "$PLIST_DEST"
sed -i '' "s|RUN_INTERVAL|$INTERVAL|g" "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "Done. Job installed and started."
echo ""
echo "  Logs:   $LOG_DIR/post-session-summary.log"
echo "  Errors: $LOG_DIR/post-session-summary.error.log"
