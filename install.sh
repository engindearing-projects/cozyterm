#!/usr/bin/env bash
# Engie installer
# Usage: curl -fsSL https://engie.engindearing.soy/install.sh | bash
#
# Installs:
#   1. Engie brain (always-on AI assistant + self-improving models)
#   2. OpenCode (terminal coding agent) — wired to engie
#   3. Ollama models (local, private)
#
# Requirements: macOS or Linux, git

set -euo pipefail

REPO="https://github.com/engindearing-projects/cozyterm.git"
BRANCH="main"
INSTALL_DIR="${ENGIE_DIR:-$HOME/.engie}"
BIN_DIR="${ENGIE_BIN:-$HOME/.local/bin}"
CONFIG_DIR="$HOME/.config/opencode"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${CYAN}  $1${RESET}"; }
ok()    { echo -e "${GREEN}  $1${RESET}"; }
warn()  { echo -e "${YELLOW}  $1${RESET}"; }
err()   { echo -e "${RED}  $1${RESET}"; exit 1; }

echo ""
echo -e "${BOLD}  Engie Installer${RESET}"
echo -e "${DIM}  AI that gets better the more you use it${RESET}"
echo ""

# ── Step 1: Check OS ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      err "Unsupported OS: $OS" ;;
esac

info "Platform: $PLATFORM ($ARCH)"

# ── Step 2: Check / install Bun ───────────────────────────────────────────────
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo 'unknown')"
  ok "Bun $BUN_VERSION found"
else
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) installed"
  else
    err "Bun installation failed. Install manually: https://bun.sh"
  fi
fi

# ── Step 3: Check git ─────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  err "git is required. Install it and try again."
fi

# ── Step 4: Clone or update engie repo ────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
  git pull origin "$BRANCH"
  ok "Updated to latest"
else
  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR exists but is not a git repo. Backing up..."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
  fi

  info "Cloning Engie..."
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── Step 5: Install dependencies ──────────────────────────────────────────────
cd "$INSTALL_DIR"
info "Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Dependencies installed"

# ── Step 6: Install OpenCode ─────────────────────────────────────────────────
info "Installing OpenCode (coding agent)..."
bun install -g opencode-ai@latest 2>/dev/null || npm install -g opencode-ai@latest 2>/dev/null
if command -v opencode &>/dev/null || [ -f "$HOME/.bun/bin/opencode" ]; then
  ok "OpenCode installed"
else
  warn "OpenCode install may need PATH update (see below)"
fi

# ── Step 7: Wire OpenCode to Engie ───────────────────────────────────────────
mkdir -p "$CONFIG_DIR/plugins"

# OpenCode config — points at local Ollama models with engie MCP bridge
cat > "$CONFIG_DIR/opencode.json" << OCEOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "engie": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Engie (local)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen2.5:7b-instruct": {
          "name": "Qwen 2.5 7B (orchestrator)",
          "limit": { "context": 32768, "output": 8192 }
        },
        "engie-coder:latest": {
          "name": "engie-coder (Forge-trained)",
          "limit": { "context": 6144, "output": 2048 }
        },
        "llama3.2": {
          "name": "Llama 3.2 (chat)",
          "limit": { "context": 131072, "output": 4096 }
        }
      }
    }
  },
  "model": "engie/qwen2.5:7b-instruct",
  "mcp": {
    "engie": {
      "type": "local",
      "command": ["bun", "run", "$INSTALL_DIR/packages/engine/src/mcp-bridge/index.mjs"],
      "enabled": true,
      "timeout": 10000
    }
  },
  "theme": "dark"
}
OCEOF
ok "OpenCode wired to Engie brain"

# Engie sync plugin — logs OpenCode sessions to engie activity server
cat > "$CONFIG_DIR/plugins/engie-sync.ts" << 'PLUGINEOF'
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";

async function post(data: Record<string, unknown>) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    await fetch(`${ACTIVITY_URL}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: c.signal,
    });
    clearTimeout(t);
  } catch {}
}

export const EngieSync = async ({ directory }: any) => {
  const key = `opencode-${Date.now()}`;
  return {
    "session.created": async () => {
      await post({ platform: "opencode", session_key: key, role: "system", content: `Session started in ${directory}` });
    },
    "tool.execute.after": async (e: any) => {
      if (!["write", "edit", "bash"].includes(e.tool?.name)) return;
      await post({ platform: "opencode", session_key: key, role: "assistant", content: `[${e.tool.name}] ${e.tool.args?.path || e.tool.args?.command || ""}`.slice(0, 500) });
    },
  };
};
PLUGINEOF
ok "Session sync plugin installed"

# ── Step 8: Create engie wrapper ──────────────────────────────────────────────
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/engie" << WRAPPER
#!/usr/bin/env bash
ENGIE_DIR="\${ENGIE_DIR:-\$HOME/.engie}"
exec bun run "\$ENGIE_DIR/packages/cli/bin/cozy.ts" "\$@"
WRAPPER
chmod +x "$BIN_DIR/engie"
ok "Installed 'engie' to $BIN_DIR/engie"

# ── Step 9: Check PATH ───────────────────────────────────────────────────────
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not in your PATH"

  SHELL_NAME="$(basename "$SHELL")"
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac

  echo ""
  echo -e "  Add this to ${BOLD}$RC_FILE${RESET}:"
  echo ""
  if [ "$SHELL_NAME" = "fish" ]; then
    echo -e "    ${CYAN}set -gx PATH $BIN_DIR \$PATH${RESET}"
  else
    echo -e "    ${CYAN}export PATH=\"$BIN_DIR:\$PATH\"${RESET}"
  fi
  echo ""
else
  ok "$BIN_DIR is in PATH"
fi

# ── Step 10: Check / install Ollama ──────────────────────────────────────────
echo ""
if command -v ollama &>/dev/null; then
  ok "Ollama found"

  if curl -sf http://localhost:11434/api/tags &>/dev/null; then
    ok "Ollama running"
    echo ""
    info "Pulling recommended models..."
    ollama pull qwen2.5:7b-instruct 2>/dev/null && ok "qwen2.5:7b-instruct ready" || warn "Pull qwen2.5:7b-instruct manually"
    ollama pull llama3.2 2>/dev/null && ok "llama3.2 ready" || warn "Pull llama3.2 manually"
  else
    warn "Ollama installed but not running. Start it: ollama serve"
    echo ""
    echo -e "  ${DIM}Then pull models:${RESET}"
    echo -e "  ${DIM}  ollama pull qwen2.5:7b-instruct${RESET}"
    echo -e "  ${DIM}  ollama pull llama3.2${RESET}"
  fi
else
  info "Ollama not found (needed for local models)"
  echo -e "  Install: ${CYAN}https://ollama.com${RESET}"
  echo ""
  echo -e "  ${DIM}Then pull models:${RESET}"
  echo -e "  ${DIM}  ollama pull qwen2.5:7b-instruct${RESET}"
  echo -e "  ${DIM}  ollama pull llama3.2${RESET}"
fi

# ── Step 11: Create data dirs ─────────────────────────────────────────────────
mkdir -p "$HOME/.engie/forge"
mkdir -p "$HOME/.engie/data"
mkdir -p "$HOME/.engie/memory"
mkdir -p "$HOME/.engie/logs"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  Engie installed.${RESET}"
echo ""
echo -e "  ${DIM}What you get:${RESET}"
echo -e "    ${CYAN}opencode${RESET}              Coding agent (wired to engie)"
echo -e "    ${CYAN}engie${RESET}                 Direct engie CLI"
echo -e "    ${CYAN}engie engine start${RESET}    Start the always-on brain"
echo -e "    ${CYAN}engie forge status${RESET}    Check model training stats"
echo ""
echo -e "  ${DIM}Every coding session trains your local models.${RESET}"
echo -e "  ${DIM}Your code never leaves your machine.${RESET}"
echo ""
echo -e "  ${DIM}Docs: https://engie.engindearing.soy${RESET}"
echo ""
