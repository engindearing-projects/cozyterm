"""Bottom panel - terminal command input and output."""

from __future__ import annotations

import os
from pathlib import Path

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Input, RichLog, Static


class CommandPanel(Widget):
    """Terminal panel with command input and scrolling output."""

    class CommandSubmitted(Message):
        """Posted when the user submits a command."""
        def __init__(self, command: str) -> None:
            super().__init__()
            self.command = command

    class CommandCompleted(Message):
        """Posted when a command finishes executing."""
        def __init__(self, command: str, exit_code: int, output: str) -> None:
            super().__init__()
            self.command = command
            self.exit_code = exit_code
            self.output = output

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._cwd = os.getcwd()
        self._history: list[str] = []
        self._history_index = -1

    def compose(self) -> ComposeResult:
        yield Static("Terminal", id="terminal-title")
        yield RichLog(id="terminal-output", wrap=True, highlight=True, markup=True)
        with Horizontal(id="terminal-input-area"):
            yield Static("$", id="terminal-prompt")
            yield Input(
                placeholder="Type a command...",
                id="terminal-input",
            )

    @property
    def cwd(self) -> str:
        return self._cwd

    @cwd.setter
    def cwd(self, value: str) -> None:
        self._cwd = value
        self.query_one("#terminal-prompt", Static).update(
            f"[green]{Path(value).name}$[/green]"
        )

    def write_output(self, text: str) -> None:
        """Write a line to the terminal output."""
        log = self.query_one("#terminal-output", RichLog)
        log.write(text)

    def write_command_header(self, command: str) -> None:
        """Write the command being executed as a header line."""
        log = self.query_one("#terminal-output", RichLog)
        log.write(f"[bold green]$ {command}[/bold green]")

    def write_exit_code(self, code: int) -> None:
        """Write the exit code after command completion."""
        log = self.query_one("#terminal-output", RichLog)
        if code != 0:
            log.write(f"[bold red]Exit code: {code}[/bold red]")
        log.write("")  # blank line separator

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "terminal-input":
            command = event.value.strip()
            if command:
                self._history.append(command)
                self._history_index = len(self._history)
                event.input.value = ""
                self.post_message(self.CommandSubmitted(command))

    def on_key(self, event) -> None:
        """Handle up/down arrow for command history."""
        inp = self.query_one("#terminal-input", Input)
        if not inp.has_focus:
            return

        if event.key == "up" and self._history:
            self._history_index = max(0, self._history_index - 1)
            inp.value = self._history[self._history_index]
            inp.cursor_position = len(inp.value)
            event.prevent_default()
        elif event.key == "down" and self._history:
            self._history_index = min(len(self._history), self._history_index + 1)
            if self._history_index < len(self._history):
                inp.value = self._history[self._history_index]
            else:
                inp.value = ""
            inp.cursor_position = len(inp.value)
            event.prevent_default()
