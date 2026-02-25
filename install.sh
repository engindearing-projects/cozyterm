#!/usr/bin/env bash
# CozyTerm installer
# Usage: curl -fsSL https://cozyterm.com/install.sh | bash
#
# Installs CozyTerm (AI coding agent for the terminal)
# Requirements: macOS or Linux, git

set -euo pipefail

REPO="https://github.com/engindearing-projects/cozyterm.git"
BRANCH="v2-rewrite"
INSTALL_DIR="${COZYTERM_DIR:-$HOME/.cozyterm}"
BIN_DIR="${COZYTERM_BIN:-$HOME/.local/bin}"

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
echo -e "${BOLD}  CozyTerm Installer${RESET}"
echo -e "${DIM}  AI coding agent for the terminal${RESET}"
echo ""

# ── Step 1: Check OS ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      err "Unsupported OS: $OS. CozyTerm supports macOS and Linux." ;;
esac

info "Platform: $PLATFORM ($ARCH)"

# ── Step 2: Check / install Bun ───────────────────────────────────────────────
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo 'unknown')"
  ok "Bun $BUN_VERSION found"
else
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash

  # Source the updated profile so bun is available
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

# ── Step 4: Clone or update repo ──────────────────────────────────────────────
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

  info "Cloning CozyTerm..."
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── Step 5: Install dependencies ──────────────────────────────────────────────
cd "$INSTALL_DIR"
info "Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Dependencies installed"

# ── Step 6: Create bin symlink ────────────────────────────────────────────────
mkdir -p "$BIN_DIR"

# Create a wrapper script that uses bun to run cozy.ts
cat > "$BIN_DIR/cozy" << 'WRAPPER'
#!/usr/bin/env bash
# CozyTerm launcher
COZYTERM_DIR="${COZYTERM_DIR:-$HOME/.cozyterm}"
exec bun run "$COZYTERM_DIR/bin/cozy.ts" "$@"
WRAPPER
chmod +x "$BIN_DIR/cozy"
ok "Installed 'cozy' to $BIN_DIR/cozy"

# ── Step 7: Check PATH ───────────────────────────────────────────────────────
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not in your PATH"

  # Detect shell and suggest fix
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
  echo -e "  Then restart your terminal or run: ${CYAN}source $RC_FILE${RESET}"
else
  ok "$BIN_DIR is in PATH"
fi

# ── Step 8: Check Ollama (optional) ──────────────────────────────────────────
echo ""
if command -v ollama &>/dev/null; then
  OLLAMA_VERSION="$(ollama --version 2>/dev/null | head -1 || echo 'installed')"
  ok "Ollama found ($OLLAMA_VERSION)"

  # Check if running
  if curl -sf http://localhost:11434/api/tags &>/dev/null; then
    MODEL_COUNT=$(curl -sf http://localhost:11434/api/tags | grep -o '"name"' | wc -l | tr -d ' ')
    ok "Ollama running ($MODEL_COUNT models)"
  else
    warn "Ollama installed but not running. Start it with: ollama serve"
  fi
else
  info "Ollama not found (optional — needed for local models)"
  echo -e "  Install: ${CYAN}https://ollama.com${RESET}"
  echo ""
  echo -e "  ${DIM}Recommended models:${RESET}"
  echo -e "  ${DIM}  ollama pull qwen2.5:7b-instruct   # tool calling${RESET}"
  echo -e "  ${DIM}  ollama pull llama3.2               # chat${RESET}"
fi

# ── Step 9: Create default config dirs ────────────────────────────────────────
mkdir -p "$HOME/.cozyterm/forge"
mkdir -p "$HOME/.cozyterm/data"
mkdir -p "$HOME/.cozyterm/commands"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  CozyTerm installed.${RESET}"
echo ""
echo -e "  ${DIM}Quick start:${RESET}"
echo -e "    ${CYAN}cozy${RESET}                    Interactive TUI"
echo -e "    ${CYAN}cozy \"fix the bug\"${RESET}      One-shot mode"
echo -e "    ${CYAN}cozy init${RESET}               Generate AGENTS.md for a project"
echo -e "    ${CYAN}cozy models${RESET}             Check model availability"
echo ""
echo -e "  ${DIM}Docs: https://cozyterm.com${RESET}"
echo -e "  ${DIM}GitHub: https://github.com/engindearing-projects/cozyterm${RESET}"
echo ""
