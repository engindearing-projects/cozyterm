#!/bin/bash
# Start CozyTerm gateway with env vars from config/.env
# All paths are resolved relative to $HOME — no hardcoded user paths.

COZYTERM_HOME="${COZYTERM_HOME:-${ENGIE_HOME:-$HOME/.cozyterm}}"
ENV_FILE="${COZYTERM_HOME}/config/.env"

# Fall back to legacy locations if config/.env doesn't exist
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="$HOME/.engie/config/.env"
fi
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="$HOME/engie/config/.env"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Resolve the script directory to find gateway.mjs
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGIE_DIR="${SCRIPT_DIR%/scripts}"

exec /opt/homebrew/bin/bun "$ENGIE_DIR/scripts/gateway.mjs"
