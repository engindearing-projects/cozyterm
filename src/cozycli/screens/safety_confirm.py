"""Modal confirmation screen for dangerous commands."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Static


class SafetyConfirmScreen(ModalScreen[bool]):
    """Warning modal shown before executing a dangerous command."""

    BINDINGS = [("escape", "dismiss(False)", "Cancel")]

    def __init__(self, command: str, warning: str) -> None:
        super().__init__()
        self.command = command
        self.warning = warning

    def compose(self) -> ComposeResult:
        with Vertical(id="safety-container"):
            yield Static("Warning: Potentially Dangerous Command", id="safety-title")
            yield Static(f"[bold]{self.command}[/bold]", id="safety-command")
            yield Static(self.warning, id="safety-warning")
            with Horizontal(id="safety-buttons"):
                yield Button("Cancel", variant="primary", id="safety-cancel")
                yield Button("Run Anyway", variant="error", id="safety-confirm")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "safety-cancel":
            self.dismiss(False)
        elif event.button.id == "safety-confirm":
            self.dismiss(True)
