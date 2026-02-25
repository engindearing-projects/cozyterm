# CozyTerm

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**An AI project manager that lives in your terminal.**

CozyTerm connects to Jira, Slack, and GitHub through a custom-built gateway running Claude and Ollama. It tracks projects, remembers context across sessions in a local SQLite database, sends morning briefs to Telegram, and routes tasks between Claude (heavy lifting) and Ollama (quick local stuff) automatically.

**[cozyterm.com](https://cozyterm.com)**

## Install

Requires [Bun](https://bun.sh) and macOS.

```bash
git clone https://github.com/engindearing-projects/cozyterm.git
cd cozyterm/cli && bun install && bun link
engie init
```

The setup wizard walks you through everything: prerequisites, Ollama install, API keys, launchd services, and a connectivity check. Picks up where it left off if you interrupt it.

## Usage

```bash
engie                              # interactive TUI
engie"what's blocking PORT-9?"     # one-shot, then exit
engiestatus                        # service health
engiedoctor --fix                  # diagnose and auto-repair
engieobserve "switched to FTS5"    # save a note
engiestart / engiestop             # manage services
```

## Commands

Inside the TUI:

| Command | What it does |
|---------|-------------|
| `/memory [query]` | Search memory (FTS5). No query = recent entries |
| `/observe <text>` | Save a note to memory |
| `/todo [add\|done]` | Manage todos (Shift+Tab to view panel) |
| `/coach` | Toggle coaching mode |
| `/explain <topic>` | Plain-language explanation of anything |
| `/suggest` | Contextual next-step suggestions |
| `/forge [cmd]` | Training pipeline controls |
| `/status` | Live service health |
| `/help` | All commands |
| `/clear` | Clear chat |
| `/quit` | Exit |

Press **Shift+Tab** to toggle the task panel — shows active tool calls, your todos, and recent observations.

## Features

- **Persistent memory** — SQLite + FTS5 full-text search. Decisions, blockers, and ticket references get captured automatically from conversations
- **Smart routing** — Claude handles complex tasks through the proxy, Ollama runs locally on Apple Silicon for quick lookups at zero API cost
- **Task panel** — Shift+Tab opens a side panel showing what's in progress, your todo list, and recent context
- **Coaching mode** — `/coach` for warmer explanations, `/explain` for plain-language breakdowns of any concept
- **Morning briefs** — Cron jobs check Jira and GitHub every morning, send a summary to Telegram
- **Self-diagnosing** — `engiedoctor` checks services, configs, and directories. `--fix` auto-repairs what it can
- **Web dashboard** — Browser-based chat and memory browser that connects to the same gateway
- **MCP bridge** — Exposes Engie as an MCP server so other AI tools can call into it
- **One-shot mode** — `engie"question"` for quick scripted answers

## Stack

- **Runtime**: Bun
- **TUI**: Ink 5 + React 18
- **Gateway**: Custom WebSocket server
- **AI**: Claude (via proxy) + Ollama (local, Apple Silicon Metal)
- **Memory**: SQLite + FTS5
- **Web**: Vite + React + TypeScript
- **Services**: macOS launchd
- **Messaging**: Telegram Bot API

## License

MIT
