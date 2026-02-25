#!/bin/bash
set -euo pipefail

# Install the background daemon as a macOS launchd service.
#
# Usage:
#   ./scripts/install-daemon-service.sh          # install and start
#   ./scripts/install-daemon-service.sh uninstall # stop and remove

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/config/logs"
LABEL="com.engie.daemon"

ACTION="${1:-install}"

mkdir -p "$LOG_DIR"

install_macos() {
  local PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
  local PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

  if [[ ! -f "$PLIST_SRC" ]]; then
    echo "Error: missing plist template $PLIST_SRC"
    exit 1
  fi

  echo "Installing launchd service..."
  cp "$PLIST_SRC" "$PLIST_DEST"

  # Replace placeholders
  sed -i '' "s|COZYTERM_SCRIPTS_DIR|$SCRIPT_DIR|g" "$PLIST_DEST"
  sed -i '' "s|COZYTERM_LOG_DIR|$LOG_DIR|g" "$PLIST_DEST"

  # Load the service
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  launchctl load "$PLIST_DEST"

  echo "Done. Service installed and started."
  echo ""
  echo "  Logs:   $LOG_DIR/daemon.log"
  echo "  Errors: $LOG_DIR/daemon.error.log"
  echo ""
  echo "  Status: launchctl list | grep engie.daemon"
  echo "  Stop:   launchctl unload $PLIST_DEST"
  echo "  Start:  launchctl load $PLIST_DEST"
}

uninstall_macos() {
  local PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [[ -f "$PLIST_DEST" ]]; then
    echo "Stopping and removing launchd service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "Done."
  else
    echo "Service not installed."
  fi
}

case "$ACTION" in
  install) install_macos ;;
  uninstall) uninstall_macos ;;
  *)
    echo "Usage: $0 [install|uninstall]"
    exit 1
    ;;
esac
