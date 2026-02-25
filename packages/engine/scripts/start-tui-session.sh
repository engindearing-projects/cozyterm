#!/bin/bash
# Start CozyTerm TUI in a named tmux session for mobile access via Mosh/SSH
SESSION="cozyterm"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already running. Attach with: tmux attach -t $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" "bun $HOME/engie/cli/bin/engie.mjs"
echo "Started CozyTerm TUI in tmux session '$SESSION'"
echo ""
echo "Attach locally:  tmux attach -t $SESSION"
echo "From iPhone:     mosh $(hostname) -- tmux attach -t $SESSION"
echo ""
echo "Tip: Install Blink Shell on iOS for the best Mosh experience."
