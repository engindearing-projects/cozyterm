"""Transform Claude responses into UI-friendly content."""

from __future__ import annotations

import json
import re

SUGGESTION_PATTERN = re.compile(r"SUGGESTIONS:\s*(\[.*?\])", re.DOTALL)


def extract_suggestions(text: str) -> list[str]:
    """Extract command suggestions from Claude's response.

    Looks for SUGGESTIONS: ["cmd1", "cmd2", ...] at the end of the response.
    """
    match = SUGGESTION_PATTERN.search(text)
    if not match:
        return []
    try:
        suggestions = json.loads(match.group(1))
        if isinstance(suggestions, list):
            return [str(s) for s in suggestions[:5]]
    except (json.JSONDecodeError, ValueError):
        pass
    return []


def strip_suggestions(text: str) -> str:
    """Remove the SUGGESTIONS: [...] line from the response text."""
    return SUGGESTION_PATTERN.sub("", text).rstrip()
