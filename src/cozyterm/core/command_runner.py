"""Async subprocess execution for terminal commands."""

from __future__ import annotations

import asyncio
import os
import subprocess
from dataclasses import dataclass


@dataclass
class CommandResult:
    """Result of a completed command."""
    command: str
    exit_code: int
    output: str


async def run_command(
    command: str,
    cwd: str | None = None,
    on_output: callable | None = None,
) -> CommandResult:
    """Run a shell command asynchronously, streaming output line by line.

    Args:
        command: The shell command to execute.
        cwd: Working directory. Defaults to current directory.
        on_output: Async callback called with each line of output.

    Returns:
        CommandResult with the full output and exit code.
    """
    if cwd is None:
        cwd = os.getcwd()

    lines: list[str] = []

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=cwd,
    )

    assert proc.stdout is not None
    while True:
        line_bytes = await proc.stdout.readline()
        if not line_bytes:
            break
        line = line_bytes.decode("utf-8", errors="replace").rstrip("\n")
        lines.append(line)
        if on_output:
            await on_output(line)

    exit_code = await proc.wait()
    output = "\n".join(lines)

    return CommandResult(command=command, exit_code=exit_code, output=output)
