"""Tests for suggestion extraction and stripping from Claude responses."""

import pytest

from cozyterm.claude.message_handler import (
    SUGGESTION_PATTERN,
    extract_suggestions,
    strip_suggestions,
)


class TestExtractSuggestions:
    """Tests for extract_suggestions()."""

    def test_basic_extraction(self) -> None:
        text = 'Here is some advice.\nSUGGESTIONS: ["ls -la", "pwd", "git status"]'
        result = extract_suggestions(text)
        assert result == ["ls -la", "pwd", "git status"]

    def test_single_suggestion(self) -> None:
        text = 'Try this command.\nSUGGESTIONS: ["ls"]'
        result = extract_suggestions(text)
        assert result == ["ls"]

    def test_no_suggestions(self) -> None:
        text = "Just a regular response with no suggestions."
        result = extract_suggestions(text)
        assert result == []

    def test_empty_suggestion_list(self) -> None:
        text = "No commands here.\nSUGGESTIONS: []"
        result = extract_suggestions(text)
        assert result == []

    def test_max_five_suggestions(self) -> None:
        """Should truncate to at most 5 suggestions."""
        text = 'SUGGESTIONS: ["a", "b", "c", "d", "e", "f", "g"]'
        result = extract_suggestions(text)
        assert len(result) == 5
        assert result == ["a", "b", "c", "d", "e"]

    def test_exactly_five_suggestions(self) -> None:
        text = 'SUGGESTIONS: ["a", "b", "c", "d", "e"]'
        result = extract_suggestions(text)
        assert len(result) == 5

    def test_suggestions_in_middle_of_text(self) -> None:
        text = (
            "Some explanation here.\n"
            'SUGGESTIONS: ["cmd1", "cmd2"]\n'
            "More text after."
        )
        result = extract_suggestions(text)
        assert result == ["cmd1", "cmd2"]

    def test_suggestions_with_extra_whitespace(self) -> None:
        text = 'SUGGESTIONS:   ["ls", "pwd"]'
        result = extract_suggestions(text)
        assert result == ["ls", "pwd"]

    def test_invalid_json_returns_empty(self) -> None:
        text = "SUGGESTIONS: [not valid json]"
        result = extract_suggestions(text)
        assert result == []

    def test_malformed_brackets_returns_empty(self) -> None:
        text = "SUGGESTIONS: {not a list}"
        result = extract_suggestions(text)
        assert result == []

    def test_non_list_json_returns_empty(self) -> None:
        """If the JSON parses but is not a list, return empty."""
        text = 'SUGGESTIONS: {"key": "value"}'
        result = extract_suggestions(text)
        assert result == []

    def test_numeric_items_converted_to_str(self) -> None:
        text = "SUGGESTIONS: [1, 2, 3]"
        result = extract_suggestions(text)
        assert result == ["1", "2", "3"]

    def test_mixed_types_converted_to_str(self) -> None:
        text = 'SUGGESTIONS: ["ls", 42, true]'
        result = extract_suggestions(text)
        assert result == ["ls", "42", "True"]

    def test_empty_string_input(self) -> None:
        assert extract_suggestions("") == []

    def test_multiline_suggestion_array(self) -> None:
        """SUGGESTION_PATTERN uses DOTALL, so multiline arrays should work."""
        text = (
            'SUGGESTIONS: [\n'
            '  "ls -la",\n'
            '  "git log --oneline"\n'
            ']'
        )
        result = extract_suggestions(text)
        assert result == ["ls -la", "git log --oneline"]

    def test_commands_with_special_characters(self) -> None:
        text = 'SUGGESTIONS: ["grep -r \'pattern\' .", "find . -name \\"*.py\\""]'
        result = extract_suggestions(text)
        assert len(result) == 2
        assert result[0] == "grep -r 'pattern' ."


class TestStripSuggestions:
    """Tests for strip_suggestions()."""

    def test_strip_removes_suggestion_line(self) -> None:
        text = 'Here is advice.\nSUGGESTIONS: ["ls", "pwd"]'
        result = strip_suggestions(text)
        assert "SUGGESTIONS" not in result
        assert result == "Here is advice."

    def test_strip_preserves_rest_of_text(self) -> None:
        text = 'Line 1.\nLine 2.\nSUGGESTIONS: ["cmd"]'
        result = strip_suggestions(text)
        assert "Line 1." in result
        assert "Line 2." in result

    def test_strip_no_suggestions_returns_original(self) -> None:
        text = "Just plain text, nothing special."
        result = strip_suggestions(text)
        assert result == text

    def test_strip_trailing_whitespace_cleaned(self) -> None:
        text = 'Content here.   \nSUGGESTIONS: ["ls"]   '
        result = strip_suggestions(text)
        assert not result.endswith(" ")
        assert not result.endswith("\n")

    def test_strip_empty_string(self) -> None:
        assert strip_suggestions("") == ""

    def test_strip_only_suggestions(self) -> None:
        text = 'SUGGESTIONS: ["ls"]'
        result = strip_suggestions(text)
        assert result == ""

    def test_strip_with_text_after_suggestions(self) -> None:
        text = 'Before.\nSUGGESTIONS: ["ls"]\nAfter text.'
        result = strip_suggestions(text)
        assert "Before." in result
        # The regex replaces the SUGGESTIONS block; remaining text depends on pattern
        assert "SUGGESTIONS" not in result


class TestSuggestionPattern:
    """Tests for the compiled regex pattern."""

    def test_pattern_matches_basic(self) -> None:
        assert SUGGESTION_PATTERN.search('SUGGESTIONS: ["a"]') is not None

    def test_pattern_group_captures_array(self) -> None:
        match = SUGGESTION_PATTERN.search('SUGGESTIONS: ["a", "b"]')
        assert match is not None
        assert match.group(1) == '["a", "b"]'

    def test_pattern_does_not_match_lowercase(self) -> None:
        """The pattern looks for SUGGESTIONS in uppercase."""
        match = SUGGESTION_PATTERN.search('suggestions: ["a"]')
        assert match is None

    def test_pattern_dotall_flag(self) -> None:
        """DOTALL should allow matching across newlines in the array."""
        text = 'SUGGESTIONS: [\n"a"\n]'
        match = SUGGESTION_PATTERN.search(text)
        assert match is not None
