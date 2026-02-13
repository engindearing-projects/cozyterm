"""ClaudeSession - manages conversation with Claude via the Anthropic SDK."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import AsyncIterator

from anthropic import AsyncAnthropic

from cozyterm.claude.prompts import SYSTEM_PROMPT


@dataclass
class ClaudeSession:
    """Manages a multi-turn conversation with Claude."""

    model: str = "claude-sonnet-4-5-20250929"
    max_tokens: int = 1024
    messages: list[dict] = field(default_factory=list)
    _client: AsyncAnthropic | None = field(default=None, repr=False)

    @property
    def client(self) -> AsyncAnthropic:
        if self._client is None:
            self._client = AsyncAnthropic()
        return self._client

    @property
    def has_api_key(self) -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY"))

    def add_user_message(self, content: str) -> None:
        self.messages.append({"role": "user", "content": content})

    def add_assistant_message(self, content: str) -> None:
        self.messages.append({"role": "assistant", "content": content})

    async def stream_response(self, user_message: str) -> AsyncIterator[str]:
        """Send a message and yield text chunks as they arrive.

        Automatically manages conversation history.
        """
        self.add_user_message(user_message)

        full_response = ""
        async with self.client.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=SYSTEM_PROMPT,
            messages=self.messages,
        ) as stream:
            async for text in stream.text_stream:
                full_response += text
                yield text

        self.add_assistant_message(full_response)
