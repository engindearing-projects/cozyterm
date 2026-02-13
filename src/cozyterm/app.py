"""Main CozyTerm application - widget composition and event routing."""

from __future__ import annotations

import os
from pathlib import Path

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header

from cozyterm.claude.message_handler import extract_suggestions, strip_suggestions
from cozyterm.claude.session import ClaudeSession
from cozyterm.core.command_runner import run_command
from cozyterm.core.safety import check_command
from cozyterm.screens.safety_confirm import SafetyConfirmScreen
from cozyterm.screens.welcome import WelcomeScreen
from cozyterm.widgets.chat_panel import ChatPanel
from cozyterm.widgets.command_panel import CommandPanel
from cozyterm.widgets.file_browser import FileBrowser
from cozyterm.widgets.suggestion_bar import SuggestionBar


class CozyTerm(App):
    """A cozy terminal coach powered by Claude."""

    TITLE = "CozyTerm"
    SUB_TITLE = "Your friendly terminal coach"
    CSS_PATH = "styles.tcss"

    BINDINGS = [
        Binding("ctrl+b", "toggle_sidebar", "Files", show=True),
        Binding("ctrl+e", "toggle_explain", "Explain", show=True),
        Binding("ctrl+t", "focus_terminal", "Terminal", show=True),
        Binding("ctrl+l", "focus_chat", "Chat", show=True),
        Binding("ctrl+q", "quit", "Quit", show=True),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.claude = ClaudeSession()
        self.explain_mode = True
        self._first_run = True

    def compose(self) -> ComposeResult:
        yield Header()
        yield SuggestionBar()
        with Horizontal(id="main-content"):
            yield FileBrowser()
            with Vertical(id="right-panels"):
                yield ChatPanel()
                yield CommandPanel()
        yield Footer()

    def on_mount(self) -> None:
        if self._first_run:
            self._first_run = False
            self.push_screen(WelcomeScreen())
        # Update terminal prompt with cwd
        cmd_panel = self.query_one(CommandPanel)
        cmd_panel.cwd = os.getcwd()
        # Show API key warning if needed
        if not self.claude.has_api_key:
            chat = self.query_one(ChatPanel)
            chat.add_message(
                "assistant",
                "**Note:** No `ANTHROPIC_API_KEY` found in your environment. "
                "Chat features are disabled.\n\n"
                "Set your key with: `export ANTHROPIC_API_KEY=sk-ant-...`\n\n"
                "You can still use the terminal and file browser!",
            )

    # === Chat handling ===

    async def on_chat_panel_user_message(self, event: ChatPanel.UserMessage) -> None:
        """Handle chat messages from the user."""
        chat = self.query_one(ChatPanel)
        chat.add_message("user", event.text)

        if not self.claude.has_api_key:
            chat.add_message(
                "assistant",
                "I need an API key to respond. Set `ANTHROPIC_API_KEY` in your environment.",
            )
            return

        # Create streaming assistant message
        msg_widget = chat.add_message("assistant", "")

        try:
            full_text = ""
            async for chunk in self.claude.stream_response(event.text):
                full_text += chunk
                msg_widget.append_text(chunk)
                chat.scroll_to_bottom()

            # Extract and display suggestions
            clean_text = strip_suggestions(full_text)
            if clean_text != full_text:
                msg_widget.append_text("")  # trigger re-render with clean text
                # Update the markdown content to strip suggestions line
                try:
                    from textual.widgets import Markdown
                    md = msg_widget.query_one(Markdown)
                    md.update(clean_text)
                except Exception:
                    pass

            suggestions = extract_suggestions(full_text)
            if suggestions:
                self.query_one(SuggestionBar).update_suggestions(suggestions)

        except Exception as e:
            msg_widget.append_text(f"\n\n**Error:** {e}")

    # === Command handling ===

    async def on_command_panel_command_submitted(
        self, event: CommandPanel.CommandSubmitted
    ) -> None:
        """Handle terminal commands from the user."""
        command = event.command
        cmd_panel = self.query_one(CommandPanel)

        # Handle cd specially
        if command.strip().startswith("cd "):
            self._handle_cd(command)
            return

        if command.strip() == "cd":
            self._handle_cd("cd ~")
            return

        # Safety check
        is_dangerous, warning = check_command(command)
        if is_dangerous:
            confirmed = await self.push_screen_wait(
                SafetyConfirmScreen(command, warning)
            )
            if not confirmed:
                cmd_panel.write_output("[yellow]Command cancelled.[/yellow]")
                cmd_panel.write_output("")
                return

        # Execute command
        cmd_panel.write_command_header(command)

        async def on_output(line: str) -> None:
            cmd_panel.write_output(line)

        result = await run_command(
            command, cwd=cmd_panel.cwd, on_output=on_output
        )
        cmd_panel.write_exit_code(result.exit_code)

        # Post completion event for explain mode
        cmd_panel.post_message(
            CommandPanel.CommandCompleted(
                command=result.command,
                exit_code=result.exit_code,
                output=result.output,
            )
        )

    async def on_command_panel_command_completed(
        self, event: CommandPanel.CommandCompleted
    ) -> None:
        """Auto-explain command if explain mode is on."""
        if not self.explain_mode:
            return
        if not self.claude.has_api_key:
            return

        # Build explanation prompt
        output_preview = event.output[:500]
        if len(event.output) > 500:
            output_preview += "\n... (truncated)"

        prompt = (
            f"The user just ran this command:\n```\n$ {event.command}\n```\n"
            f"Exit code: {event.exit_code}\n"
            f"Output:\n```\n{output_preview}\n```\n\n"
            "Briefly explain what this command did and what the output means. "
            "Keep it concise (2-4 sentences)."
        )

        chat = self.query_one(ChatPanel)
        msg_widget = chat.add_message("assistant", "")

        try:
            full_text = ""
            async for chunk in self.claude.stream_response(prompt):
                full_text += chunk
                msg_widget.append_text(chunk)
                chat.scroll_to_bottom()

            suggestions = extract_suggestions(full_text)
            if suggestions:
                self.query_one(SuggestionBar).update_suggestions(suggestions)
                clean_text = strip_suggestions(full_text)
                try:
                    from textual.widgets import Markdown
                    md = msg_widget.query_one(Markdown)
                    md.update(clean_text)
                except Exception:
                    pass
        except Exception as e:
            msg_widget.append_text(f"\n\n**Error:** {e}")

    def _handle_cd(self, command: str) -> None:
        """Handle cd command by changing the working directory."""
        cmd_panel = self.query_one(CommandPanel)
        parts = command.strip().split(maxsplit=1)
        target = parts[1] if len(parts) > 1 else os.path.expanduser("~")
        target = os.path.expanduser(target)

        try:
            target_path = Path(target)
            if not target_path.is_absolute():
                target_path = Path(cmd_panel.cwd) / target_path
            target_path = target_path.resolve()

            if not target_path.is_dir():
                cmd_panel.write_output(f"[red]cd: no such directory: {target}[/red]")
                cmd_panel.write_output("")
                return

            os.chdir(target_path)
            cmd_panel.cwd = str(target_path)
            cmd_panel.write_command_header(command)
            cmd_panel.write_output(f"[dim]{target_path}[/dim]")
            cmd_panel.write_output("")

            # Update file browser
            file_browser = self.query_one(FileBrowser)
            from textual.widgets import DirectoryTree
            tree = file_browser.query_one(DirectoryTree)
            tree.path = target_path

        except Exception as e:
            cmd_panel.write_output(f"[red]cd: {e}[/red]")
            cmd_panel.write_output("")

    # === File browser ===

    async def on_file_browser_file_selected(
        self, event: FileBrowser.FileSelected
    ) -> None:
        """When a file is clicked, ask Claude to explain it."""
        path = event.path
        chat = self.query_one(ChatPanel)

        if not self.claude.has_api_key:
            chat.add_message(
                "assistant",
                f"**{path.name}** - Set `ANTHROPIC_API_KEY` to get explanations.",
            )
            return

        # Read a preview of the file
        try:
            content = path.read_text(errors="replace")[:1000]
            if len(content) >= 1000:
                content += "\n... (truncated)"
        except Exception:
            content = "(binary or unreadable file)"

        prompt = (
            f"The user clicked on this file: `{path.name}` (full path: `{path}`)\n"
            f"File size: {path.stat().st_size} bytes\n"
            f"Preview:\n```\n{content}\n```\n\n"
            "Explain what this file is and what it does in 2-3 sentences. "
            "If it's a common file type, mention that."
        )

        msg_widget = chat.add_message("assistant", "")

        try:
            full_text = ""
            async for chunk in self.claude.stream_response(prompt):
                full_text += chunk
                msg_widget.append_text(chunk)
                chat.scroll_to_bottom()
        except Exception as e:
            msg_widget.append_text(f"\n\n**Error:** {e}")

    # === Suggestion bar ===

    async def on_suggestion_bar_suggestion_clicked(
        self, event: SuggestionBar.SuggestionClicked
    ) -> None:
        """Run the clicked suggestion command."""
        cmd_panel = self.query_one(CommandPanel)
        cmd_panel.post_message(CommandPanel.CommandSubmitted(event.command))

    # === Keybinding actions ===

    def action_toggle_sidebar(self) -> None:
        file_browser = self.query_one(FileBrowser)
        file_browser.display = not file_browser.display

    def action_toggle_explain(self) -> None:
        self.explain_mode = not self.explain_mode
        status = "on" if self.explain_mode else "off"
        self.notify(f"Explain mode: {status}")

    def action_focus_terminal(self) -> None:
        from textual.widgets import Input
        cmd_panel = self.query_one(CommandPanel)
        cmd_panel.query_one("#terminal-input", Input).focus()

    def action_focus_chat(self) -> None:
        from textual.widgets import Input
        chat = self.query_one(ChatPanel)
        chat.query_one("#chat-input", Input).focus()
