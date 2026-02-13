"""First-run onboarding welcome screen."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Static


class WelcomeScreen(ModalScreen[bool]):
    """Welcome screen shown on first run."""

    BINDINGS = [("escape", "dismiss(True)", "Close")]

    def compose(self) -> ComposeResult:
        with Vertical(id="welcome-container"):
            yield Static("Welcome to CozyTerm!", id="welcome-title")
            yield Static(
                "Your friendly terminal coach, powered by Claude.\n\n"
                "CozyTerm helps you learn the terminal by doing.\n"
                "Ask questions, run commands, and explore files\n"
                "- Claude will explain everything along the way.\n\n"
                "[bold]Tips:[/bold]\n"
                "- Type commands in the terminal panel at the bottom\n"
                "- Ask Claude questions in the chat panel\n"
                "- Click files in the sidebar to learn what they are\n"
                "- Click suggestion chips at the top to try commands\n\n"
                "[dim]Ctrl+B toggle sidebar | Ctrl+E toggle explain mode | Ctrl+T focus terminal[/dim]",
                id="welcome-body",
            )
            yield Button("Let's Go!", variant="primary", id="welcome-start")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "welcome-start":
            self.dismiss(True)
