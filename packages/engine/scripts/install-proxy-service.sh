#!/bin/bash
set -euo pipefail

# Install the Claude Code Proxy as a macOS launchd service
# or as a systemd service on Linux.
#
# Usage:
#   ./scripts/install-proxy-service.sh          # install and start
#   ./scripts/install-proxy-service.sh uninstall # stop and remove

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/config/logs"
LABEL="com.cozyterm.claude-proxy"

ACTION="${1:-install}"

mkdir -p "$LOG_DIR"

# ── macOS (launchd) ──────────────────────────────────────────────────────────
install_macos() {
  local PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
  local PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
  local NODE_BIN

  # Find node binary
  NODE_BIN="$(which node)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "Error: node not found on PATH"
    exit 1
  fi

  # Check claude is available
  if ! command -v claude &>/dev/null; then
    echo "Error: claude CLI not found"
    echo "  Install: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi

  # Get the PATH that includes claude
  local FULL_PATH
  FULL_PATH="$(dirname "$(which claude)"):$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

  echo "Installing launchd service..."

  # Copy and patch the plist
  cp "$PLIST_SRC" "$PLIST_DEST"

  # Replace placeholders
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|COZYTERM_SCRIPTS_DIR|$SCRIPT_DIR|g" "$PLIST_DEST"
    sed -i '' "s|COZYTERM_LOG_DIR|$LOG_DIR|g" "$PLIST_DEST"
    sed -i '' "s|/usr/local/bin/node|$NODE_BIN|g" "$PLIST_DEST"
    sed -i '' "s|/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin|$FULL_PATH|g" "$PLIST_DEST"
  fi

  # Load the service
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  launchctl load "$PLIST_DEST"

  echo "Done. Service installed and started."
  echo ""
  echo "  Logs:   $LOG_DIR/claude-proxy.log"
  echo "  Errors: $LOG_DIR/claude-proxy.error.log"
  echo ""
  echo "  Status: launchctl list | grep cozyterm"
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

# ── Linux (systemd) ──────────────────────────────────────────────────────────
install_linux() {
  local SERVICE_FILE="$HOME/.config/systemd/user/cozyterm-claude-proxy.service"
  local NODE_BIN
  NODE_BIN="$(which node)"

  if [[ -z "$NODE_BIN" ]]; then
    echo "Error: node not found"
    exit 1
  fi

  if ! command -v claude &>/dev/null; then
    echo "Error: claude CLI not found"
    exit 1
  fi

  local CLAUDE_BIN_DIR
  CLAUDE_BIN_DIR="$(dirname "$(which claude)")"

  mkdir -p "$(dirname "$SERVICE_FILE")"

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CozyTerm Claude Code Proxy
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $SCRIPT_DIR/claude-code-proxy.mjs
WorkingDirectory=$SCRIPT_DIR
Environment=CLAUDE_PROXY_PORT=18791
Environment=CLAUDE_PROXY_MODEL=sonnet
Environment=PATH=$CLAUDE_BIN_DIR:$NODE_BIN:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10

StandardOutput=append:$LOG_DIR/claude-proxy.log
StandardError=append:$LOG_DIR/claude-proxy.error.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable cozyterm-claude-proxy
  systemctl --user start cozyterm-claude-proxy

  echo "Done. systemd service installed and started."
  echo ""
  echo "  Status:  systemctl --user status cozyterm-claude-proxy"
  echo "  Logs:    journalctl --user -u cozyterm-claude-proxy -f"
  echo "  Stop:    systemctl --user stop cozyterm-claude-proxy"
  echo "  Restart: systemctl --user restart cozyterm-claude-proxy"
}

uninstall_linux() {
  systemctl --user stop cozyterm-claude-proxy 2>/dev/null || true
  systemctl --user disable cozyterm-claude-proxy 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/cozyterm-claude-proxy.service"
  systemctl --user daemon-reload
  echo "Done."
}

# ── Main ─────────────────────────────────────────────────────────────────────
case "$ACTION" in
  install)
    if [[ "$(uname)" == "Darwin" ]]; then
      install_macos
    else
      install_linux
    fi
    ;;
  uninstall)
    if [[ "$(uname)" == "Darwin" ]]; then
      uninstall_macos
    else
      uninstall_linux
    fi
    ;;
  *)
    echo "Usage: $0 [install|uninstall]"
    exit 1
    ;;
esac
