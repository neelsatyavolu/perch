"""Subprocess wrapper that never logs secret values."""

from __future__ import annotations

import shlex
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

MASK = "***"


def redact(text: str, secrets: Sequence[str]) -> str:
    """Replace every non-empty secret in text with ***, longest first."""
    for secret in sorted((s for s in secrets if s), key=len, reverse=True):
        text = text.replace(secret, MASK)
    return text


def run(
    cmd: Sequence[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    secrets: Sequence[str] = (),
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run cmd, logging it to stderr with secrets masked."""
    line = shlex.join(str(part) for part in cmd)
    print(f"$ {redact(line, secrets)}", file=sys.stderr, flush=True)
    return subprocess.run(
        [str(part) for part in cmd],
        cwd=cwd,
        env=dict(env) if env is not None else None,
        check=check,
        text=True,
        capture_output=capture,
    )
