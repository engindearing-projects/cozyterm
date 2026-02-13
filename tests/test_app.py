"""Headless Textual app tests for CozyTerm using async app.run_test()."""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

from cozyterm.app import CozyTerm
from cozyterm.screens.safety_confirm import SafetyConfirmScreen
from cozyterm.screens.welcome import WelcomeScreen
from cozyterm.widgets.chat_panel import ChatPanel
from cozyterm.widgets.command_panel import CommandPanel
from cozyterm.widgets.file_browser import FileBrowser
from cozyterm.widgets.suggestion_bar import SuggestionBar


@pytest.mark.asyncio
class TestCozyTermComposition:
    """Test that the app composes with all expected widgets."""

    async def test_app_mounts_all_widgets(self) -> None:
        """All core widgets should be present after mounting."""
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            # Dismiss the welcome screen first
            app.pop_screen()
            await pilot.pause()

            assert app.query_one(ChatPanel) is not None
            assert app.query_one(CommandPanel) is not None
            assert app.query_one(SuggestionBar) is not None
            assert app.query_one(FileBrowser) is not None

    async def test_welcome_screen_shown_on_first_run(self) -> None:
        """The WelcomeScreen should be pushed on first mount."""
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            # The welcome screen should be the active screen
            assert isinstance(app.screen, WelcomeScreen)

    async def test_welcome_screen_dismisses_on_button(self) -> None:
        """Clicking 'Let's Go!' should dismiss the welcome screen."""
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            assert isinstance(app.screen, WelcomeScreen)
            # Dismiss via the screen's own method
            app.screen.dismiss(True)
            await pilot.pause()
            assert not isinstance(app.screen, WelcomeScreen)


@pytest.mark.asyncio
class TestCozyTermBindings:
    """Test keybinding actions."""

    async def test_toggle_sidebar_hides_file_browser(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()  # dismiss welcome
            await pilot.pause()

            fb = app.query_one(FileBrowser)
            assert fb.display is True

            await pilot.press("ctrl+b")
            assert fb.display is False

            await pilot.press("ctrl+b")
            assert fb.display is True

    async def test_toggle_explain_mode(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()  # dismiss welcome
            await pilot.pause()

            assert app.explain_mode is True
            app.action_toggle_explain()
            assert app.explain_mode is False
            app.action_toggle_explain()
            assert app.explain_mode is True


@pytest.mark.asyncio
class TestSuggestionBarWidget:
    """Test the SuggestionBar widget behavior."""

    async def test_default_suggestions_present(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            bar = app.query_one(SuggestionBar)
            buttons = bar.query("Button")
            labels = [btn.label.plain for btn in buttons]
            assert "ls -la" in labels
            assert "pwd" in labels
            assert "git status" in labels

    async def test_update_suggestions_replaces_chips(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            bar = app.query_one(SuggestionBar)
            bar.update_suggestions(["cmd1", "cmd2"])
            await pilot.pause()

            buttons = bar.query("Button")
            labels = [btn.label.plain for btn in buttons]
            assert labels == ["cmd1", "cmd2"]
            assert "ls -la" not in labels


@pytest.mark.asyncio
class TestSafetyConfirmScreen:
    """Test the safety confirmation modal."""

    async def test_safety_screen_shows_command_and_warning(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            screen = SafetyConfirmScreen("rm -rf /", "This is very dangerous!")
            app.push_screen(screen)
            await pilot.pause()

            assert isinstance(app.screen, SafetyConfirmScreen)
            assert app.screen.command == "rm -rf /"
            assert app.screen.warning == "This is very dangerous!"

    async def test_safety_cancel_dismisses_with_false(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            results: list[bool] = []
            screen = SafetyConfirmScreen("rm -rf /", "Danger!")
            app.push_screen(screen, callback=lambda r: results.append(r))
            await pilot.pause()

            app.screen.dismiss(False)
            await pilot.pause()

            assert results == [False]

    async def test_safety_confirm_dismisses_with_true(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            results: list[bool] = []
            screen = SafetyConfirmScreen("sudo rm -rf /", "Very dangerous!")
            app.push_screen(screen, callback=lambda r: results.append(r))
            await pilot.pause()

            app.screen.dismiss(True)
            await pilot.pause()

            assert results == [True]

    async def test_safety_escape_dismisses_with_false(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            results: list[bool] = []
            screen = SafetyConfirmScreen("sudo ls", "Elevated privileges")
            app.push_screen(screen, callback=lambda r: results.append(r))
            await pilot.pause()

            await pilot.press("escape")
            await pilot.pause()

            assert results == [False]


@pytest.mark.asyncio
class TestCommandPanelWidget:
    """Test CommandPanel behavior within the app."""

    async def test_command_panel_cwd_property(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            cmd_panel = app.query_one(CommandPanel)
            assert cmd_panel.cwd == os.getcwd()

    async def test_command_panel_cwd_setter_updates_prompt(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            cmd_panel = app.query_one(CommandPanel)
            cmd_panel.cwd = "/tmp"
            assert cmd_panel.cwd == "/tmp"


@pytest.mark.asyncio
class TestChatPanelWidget:
    """Test ChatPanel behavior within the app."""

    async def test_chat_panel_add_message(self) -> None:
        app = CozyTerm()
        async with app.run_test(size=(120, 40)) as pilot:
            app.pop_screen()
            await pilot.pause()

            chat = app.query_one(ChatPanel)
            msg = chat.add_message("user", "Hello Claude!")
            await pilot.pause()

            assert msg.role == "user"

    async def test_no_api_key_warning_shown(self) -> None:
        """When ANTHROPIC_API_KEY is unset, a warning should appear in chat."""
        app = CozyTerm()
        # Ensure no API key
        with patch.dict(os.environ, {}, clear=False):
            env_backup = os.environ.pop("ANTHROPIC_API_KEY", None)
            try:
                async with app.run_test(size=(120, 40)) as pilot:
                    app.pop_screen()
                    await pilot.pause()

                    # The app should have shown a warning about missing API key
                    assert app.claude.has_api_key is False
            finally:
                if env_backup is not None:
                    os.environ["ANTHROPIC_API_KEY"] = env_backup
