# CozyTerm

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**An AI project manager that lives in your terminal, powered by Engie.**

CozyTerm is a Bun + Ink TUI that connects to an OpenClaw gateway running Claude and Ollama. It tracks projects, remembers context across sessions with a local SQLite memory database, and has a coaching mode for warm explanations of anything you throw at it.

**[cozyterm.com](https://cozyterm.com)**

## Install

Requires [Bun](https://bun.sh) and macOS.

```bash
git clone https://github.com/engindearing-projects/cozyterm.git
cd cozyterm/cli && bun install && bun link
cozy init
```

The setup wizard walks through 10 steps: checks prerequisites, installs OpenClaw + Ollama, configures API keys, starts launchd services, and runs a health check. It resumes if interrupted.

## Usage

```bash
cozy                        # interactive TUI
cozy "what's blocking PORT-9?"  # one-shot answer, then exit
cozy status                 # service health table
cozy doctor --fix           # diagnose and auto-repair
cozy observe "decided to use FTS5 for memory"  # save a note
cozy start / cozy stop      # manage launchd services
cozy web                    # open web UI in browser
```

## Slash Commands

Available inside the TUI:

| Command | What it does |
|---------|-------------|
| `/memory [query]` | Search the memory database (FTS5). No query shows recent entries |
| `/observe <text>` | Save an observation to memory |
| `/coach` | Toggle coaching mode on/off |
| `/explain <concept>` | Get a warm, plain-language explanation |
| `/suggest` | Get 3-5 contextual next-step suggestions |
| `/status` | Show live service health (gateway, claude, ollama) |
| `/help` | Print all available commands |
| `/clear` | Clear message history |
| `/quit` | Exit |

## Features

- **Persistent memory** — SQLite + FTS5 full-text search. Decisions, blockers, and context are captured automatically from every conversation. Observations are tagged with Jira ticket patterns (PORT-12, AD-1200, etc.)
- **Coaching mode** — `/coach` toggles friendly explanations. `/explain` wraps any concept in a warm prompt with analogies first, technical details second
- **Dual model routing** — Claude handles complex tasks through a local proxy. Ollama runs on Apple Silicon for quick lookups at zero cost. The OpenClaw gateway routes automatically
- **Context-aware banner** — Iris pulse glyph, personalized greeting, today's observation count, active Jira tickets, and rotating tips
- **Suggestion chips** — Arrow-key navigable horizontal chips populated from Engie's responses. Enter to select
- **Self-diagnosing** — `cozy doctor` checks every service, config file, and directory. `--fix` auto-restarts unhealthy services, creates missing paths, rotates logs
- **One-shot mode** — `cozy "question"` streams to stdout and exits, for scripting or quick answers
- **Input history** — Up/down arrows to recall previous messages
- **Cross-platform notifications** — Banner shows unread counts from Telegram and other connected channels

## Architecture

```
cli/
├── bin/cozy.mjs            # Entry point — CLI arg parsing, mode dispatch
├── tui/
│   ├── App.js              # Main Ink layout — banner, messages, input
│   ├── Banner.js           # Iris pulse, greeting, tips, unread badge
│   ├── MessageHistory.js   # Scrolling message list (Ink Static)
│   ├── StreamingMessage.js # Live streaming text with spinner + markdown
│   ├── SuggestionChips.js  # Arrow-key navigable chip bar
│   ├── StatusBar.js        # Service health dots + session key
│   ├── InputPrompt.js      # cozy > prompt with text input
│   └── WizardApp.js        # 10-step setup wizard with resume
├── src/
│   └── gateway.mjs         # WebSocket client for OpenClaw gateway
├── lib/
│   ├── memory-db.js        # SQLite + FTS5 memory database
│   ├── auto-observer.js    # Extract observations from conversations
│   ├── services.js         # launchd plist management
│   └── log-rotation.js     # Log rotate + archive + cleanup
├── commands/
│   ├── chat.mjs            # Interactive + one-shot chat dispatch
│   ├── doctor.mjs          # Diagnostic checklist with --fix
│   ├── status.mjs          # Service health table
│   └── observe.mjs         # CLI observation command
└── hooks/
    └── useSlashCommands.js  # Client-side slash command handling
```

Built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal), [Bun](https://bun.sh), and [OpenClaw](https://github.com/open-claw/open-claw).

## Stack

- **Runtime**: Bun
- **TUI**: Ink 5 + React 18
- **Gateway**: OpenClaw (WebSocket protocol)
- **AI**: Claude (via proxy) + Ollama (local, Apple Silicon Metal)
- **Memory**: SQLite with FTS5 virtual tables
- **Services**: macOS launchd

## License

MIT
