"""Left sidebar - directory tree file browser."""

from __future__ import annotations

import os
from pathlib import Path

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import DirectoryTree, Static


class FileBrowser(Widget):
    """File browser sidebar with a directory tree."""

    class FileSelected(Message):
        """Posted when a file is clicked in the browser."""
        def __init__(self, path: Path) -> None:
            super().__init__()
            self.path = path

    def compose(self) -> ComposeResult:
        yield Static("Files", id="file-browser-title")
        yield DirectoryTree(os.getcwd())

    def on_directory_tree_file_selected(
        self, event: DirectoryTree.FileSelected
    ) -> None:
        event.stop()
        self.post_message(self.FileSelected(event.path))
