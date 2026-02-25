# CozyTerm

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**The AI coding agent that gets better the more you use it.**

CozyTerm is an open-source terminal coding assistant with a multi-model architecture, LSP integration, and a self-improving training pipeline called Forge. Every session trains your local models. Your code makes them smarter.

Built from scratch — no third-party agent frameworks.

**[cozyterm.com](https://cozyterm.com)**

## Install

```bash
curl -fsSL https://cozyterm.com/install.sh | bash
```

Or with Homebrew:

```bash
brew install engindearing/tap/cozyterm
```

The installer handles Bun, clones the repo, and puts `cozy` in your PATH. Then pull some models:

```bash
ollama pull qwen2.5:7b-instruct   # orchestrator (tool calling)
ollama pull llama3.2               # chat
```

## Usage

```bash
cozy                          # interactive TUI
cozy "fix the login bug"      # one-shot mode
cozy --plan                   # read-only analysis (no file changes)
cozy /review                  # run a custom command
cozy models                   # check model availability
```

## Engine (always-on brain)

The engine runs in the background — watching repos, running tasks autonomously, creating PRs for you to review, and sending notifications. Every action feeds training data back to Forge.

```bash
cozy engine install           # install as launchd service
cozy engine start             # start the daemon
cozy engine status            # check if it's running
cozy engine logs              # tail engine output
cozy engine stop              # stop the daemon
```

## Multi-Model Architecture

Each task is routed to the right specialist:

| Role | Default Model | Purpose |
|------|--------------|---------|
| **Orchestrator** | qwen2.5:7b-instruct | Tool calling and agent loop |
| **Coder** | engie-coder:latest | Code generation (Forge-trained) |
| **Reasoner** | glm-4.7-flash | Analysis, planning, debugging |
| **Chat** | llama3.2 | Conversation, quick answers |

All models run locally via [Ollama](https://ollama.com). Swap any model in `.cozyterm.json`. Falls back to Anthropic API when Ollama is unavailable.

## Tools

The agent has 8 built-in tools:

| Tool | What it does |
|------|-------------|
| `read` | Read files with line numbers |
| `write` | Create or overwrite files |
| `edit` | Find-and-replace with uniqueness check |
| `bash` | Run shell commands (with safety blocks) |
| `glob` | Find files by pattern |
| `grep` | Search file contents |
| `undo` | Revert file changes |
| `diagnostics` | Check LSP errors after edits |

Plus any tools discovered via MCP servers defined in your config.

## Forge (self-improving models)

Every coding session is captured as training data. Forge fine-tunes your models and deploys better versions automatically.

```bash
cozy forge status             # training stats and collector data
cozy forge train              # run full pipeline: prepare → train → deploy → eval
cozy forge eval               # benchmark against previous versions
cozy forge versions           # model version history
cozy forge rollback           # revert to previous version
```

The pipeline: **Collect** → **Prepare** → **Train** (LoRA) → **Deploy** (quantize + register in Ollama) → **Eval** (benchmark).

## Features

- **LSP integration** — auto-detects TypeScript, Python, Go, Rust. Self-corrects after edits.
- **Permission system** — interactive prompts for risky tools. Allow once, always, or deny forever.
- **Custom commands** — markdown files in `.cozyterm/commands/`. Run with `/review`, `/test`, etc.
- **Session persistence** — SQLite-backed conversation history with file edit snapshots.
- **MCP support** — connect external tools via Model Context Protocol.
- **Themes** — cozyterm (warm amber), dracula, tokyonight. Switch with `--theme`.

## Project Structure

```
packages/
  cli/          Interactive coding agent TUI
  engine/       Always-on brain (daemon, gateway, memory, channels)
  trainer/      Forge pipeline (collect, prepare, train, deploy, eval)
  shared/       Constants, types, theme
site/           cozyterm.com
install.sh      One-line installer
```

## Config

Project config: `.cozyterm.json` in your project root.
Global config: `~/.cozyterm/config.json`.
Custom commands: `.cozyterm/commands/*.md` (project or global).

## License

MIT
