"""Destructive command detection and safety warnings."""

import re

# Patterns that match destructive or dangerous commands
DANGEROUS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)", re.I),
     "This rm command uses force/recursive flags and could delete many files permanently."),
    (re.compile(r"\brm\s+-rf\s+/", re.I),
     "This would recursively delete from the root filesystem!"),
    (re.compile(r"\bsudo\b"),
     "This command runs with elevated privileges. Make sure you trust it."),
    (re.compile(r"\bmkfs\b"),
     "This formats a filesystem, which destroys all data on the target."),
    (re.compile(r"\bdd\s+.*\bof=/dev/", re.I),
     "This writes directly to a device, which can destroy data."),
    (re.compile(r">\s*/dev/sd[a-z]"),
     "This redirects output directly to a block device."),
    (re.compile(r"\bchmod\s+(-R\s+)?777\b"),
     "Setting 777 permissions makes files readable/writable/executable by everyone."),
    (re.compile(r"\bchown\s+-R\b"),
     "Recursive ownership changes can affect many files."),
    (re.compile(r":\(\)\{\s*:\|:&\s*\};:"),
     "This is a fork bomb that will crash your system."),
    (re.compile(r"\bkill\s+-9\b"),
     "Force-killing a process can cause data loss."),
    (re.compile(r"\bkillall\b"),
     "This kills all processes matching a name."),
    (re.compile(r"\b>\s*/etc/"),
     "This overwrites a system configuration file."),
    (re.compile(r"\bcurl\b.*\|\s*(bash|sh)\b"),
     "Piping a remote script directly to a shell is risky."),
    (re.compile(r"\bwget\b.*\|\s*(bash|sh)\b"),
     "Piping a remote script directly to a shell is risky."),
]


def check_command(command: str) -> tuple[bool, str]:
    """Check if a command is potentially destructive.

    Returns (is_dangerous, warning_message).
    """
    command = command.strip()
    for pattern, message in DANGEROUS_PATTERNS:
        if pattern.search(command):
            return True, message
    return False, ""
