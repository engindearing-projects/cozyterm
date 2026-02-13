"""Center panel - Claude chat with message history and streaming."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Input, Markdown, Static


class ChatMessage(Static):
    """A single chat message bubble."""

    def __init__(self, role: str, content: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self.role = role
        self._content = content
        role_class = "user-message" if role == "user" else "assistant-message"
        self.add_class("chat-message", role_class)

    def compose(self) -> ComposeResult:
        role_label = "You" if self.role == "user" else "Claude"
        yield Static(f"[bold]{role_label}[/bold]", classes="message-role")
        yield Markdown(self._content, id=f"md-{id(self)}")

    def append_text(self, text: str) -> None:
        """Append text to a streaming message."""
        self._content += text
        try:
            md = self.query_one(Markdown)
            md.update(self._content)
        except Exception:
            pass


class ChatPanel(Widget):
    """Chat panel with message history and input."""

    class UserMessage(Message):
        """Posted when the user sends a chat message."""
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="chat-scroll"):
            yield Static(
                "[dim]Ask Claude anything about the terminal...[/dim]",
                id="chat-placeholder",
            )
        with Vertical(id="chat-input-area"):
            yield Input(
                placeholder="Ask Claude anything...",
                id="chat-input",
            )

    def add_message(self, role: str, content: str = "") -> ChatMessage:
        """Add a message to the chat and return it for streaming updates."""
        scroll = self.query_one("#chat-scroll", VerticalScroll)
        # Remove placeholder on first message
        try:
            placeholder = self.query_one("#chat-placeholder")
            placeholder.remove()
        except Exception:
            pass
        msg = ChatMessage(role, content)
        scroll.mount(msg)
        scroll.scroll_end(animate=False)
        return msg

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "chat-input":
            text = event.value.strip()
            if text:
                event.input.value = ""
                self.post_message(self.UserMessage(text))

    def scroll_to_bottom(self) -> None:
        scroll = self.query_one("#chat-scroll", VerticalScroll)
        scroll.scroll_end(animate=False)
