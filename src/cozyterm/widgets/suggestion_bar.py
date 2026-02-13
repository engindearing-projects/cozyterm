"""Top bar showing contextual command suggestions as clickable chips."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Button


class SuggestionBar(Widget):
    """Displays clickable command suggestion chips."""

    DEFAULT_CSS = ""

    class SuggestionClicked(Message):
        """Posted when a suggestion chip is clicked."""
        def __init__(self, command: str) -> None:
            super().__init__()
            self.command = command

    def compose(self) -> ComposeResult:
        # Start with some default suggestions
        for cmd in ["ls -la", "pwd", "git status"]:
            yield Button(cmd, classes="suggestion-chip", id=f"chip-{cmd.replace(' ', '-')}")

    def update_suggestions(self, suggestions: list[str]) -> None:
        """Replace current suggestions with new ones."""
        self.remove_children()
        for i, cmd in enumerate(suggestions[:5]):
            btn = Button(cmd, classes="suggestion-chip", id=f"chip-{i}")
            self.mount(btn)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.post_message(self.SuggestionClicked(event.button.label.plain))
