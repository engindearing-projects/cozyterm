"""Tests for async command execution via command_runner."""

import asyncio
import os
import tempfile

import pytest
import pytest_asyncio

from cozyterm.core.command_runner import CommandResult, run_command


class TestCommandResult:
    """Tests for the CommandResult dataclass."""

    def test_fields(self) -> None:
        result = CommandResult(command="ls", exit_code=0, output="file.txt")
        assert result.command == "ls"
        assert result.exit_code == 0
        assert result.output == "file.txt"

    def test_equality(self) -> None:
        a = CommandResult(command="ls", exit_code=0, output="")
        b = CommandResult(command="ls", exit_code=0, output="")
        assert a == b

    def test_inequality(self) -> None:
        a = CommandResult(command="ls", exit_code=0, output="")
        b = CommandResult(command="ls", exit_code=1, output="")
        assert a != b


@pytest.mark.asyncio
class TestRunCommand:
    """Tests for the run_command async function."""

    async def test_simple_echo(self) -> None:
        result = await run_command("echo hello")
        assert result.exit_code == 0
        assert result.output == "hello"
        assert result.command == "echo hello"

    async def test_multiline_output(self) -> None:
        result = await run_command("printf 'line1\nline2\nline3'")
        assert result.exit_code == 0
        lines = result.output.split("\n")
        assert lines == ["line1", "line2", "line3"]

    async def test_failing_command(self) -> None:
        result = await run_command("false")
        assert result.exit_code != 0
        assert result.command == "false"

    async def test_exit_code_preserved(self) -> None:
        result = await run_command("exit 42")
        assert result.exit_code == 42

    async def test_stderr_merged_into_output(self) -> None:
        """stderr should be captured in output since stdout and stderr are merged."""
        result = await run_command("echo error_text >&2")
        assert result.exit_code == 0
        assert "error_text" in result.output

    async def test_cwd_parameter(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = await run_command("pwd", cwd=tmpdir)
            assert result.exit_code == 0
            # Resolve both to handle symlinks (e.g., /private/tmp on macOS)
            assert os.path.realpath(result.output.strip()) == os.path.realpath(tmpdir)

    async def test_cwd_defaults_to_current_directory(self) -> None:
        result = await run_command("pwd")
        assert result.exit_code == 0
        assert os.path.realpath(result.output.strip()) == os.path.realpath(os.getcwd())

    async def test_on_output_callback_receives_lines(self) -> None:
        received_lines: list[str] = []

        async def callback(line: str) -> None:
            received_lines.append(line)

        result = await run_command("printf 'a\nb\nc'", on_output=callback)
        assert result.exit_code == 0
        assert received_lines == ["a", "b", "c"]

    async def test_on_output_callback_order(self) -> None:
        """Lines should arrive in order to the callback."""
        received: list[str] = []

        async def callback(line: str) -> None:
            received.append(line)

        await run_command("echo first && echo second && echo third", on_output=callback)
        assert received == ["first", "second", "third"]

    async def test_on_output_none_is_fine(self) -> None:
        """on_output=None should not cause errors."""
        result = await run_command("echo ok", on_output=None)
        assert result.exit_code == 0
        assert result.output == "ok"

    async def test_empty_output(self) -> None:
        result = await run_command("true")
        assert result.exit_code == 0
        assert result.output == ""

    async def test_large_output(self) -> None:
        """Should handle commands that produce many lines."""
        result = await run_command("seq 1 100")
        assert result.exit_code == 0
        lines = result.output.strip().split("\n")
        assert len(lines) == 100
        assert lines[0] == "1"
        assert lines[-1] == "100"

    async def test_special_characters_in_output(self) -> None:
        result = await run_command("echo 'hello world! @#$%'")
        assert result.exit_code == 0
        assert "hello world!" in result.output

    async def test_command_with_pipe(self) -> None:
        result = await run_command("echo 'hello world' | tr ' ' '_'")
        assert result.exit_code == 0
        assert result.output.strip() == "hello_world"

    async def test_command_with_env_variable(self) -> None:
        result = await run_command("echo $HOME")
        assert result.exit_code == 0
        assert result.output.strip() != ""
        assert result.output.strip() != "$HOME"

    async def test_nonexistent_command(self) -> None:
        """Running a command that does not exist should return a non-zero exit code."""
        result = await run_command("this_command_does_not_exist_xyz_12345")
        assert result.exit_code != 0

    async def test_cwd_nonexistent_raises(self) -> None:
        """Providing a nonexistent cwd should raise an error."""
        with pytest.raises((FileNotFoundError, NotADirectoryError, OSError)):
            await run_command("echo hi", cwd="/nonexistent/path/xyz_12345")
