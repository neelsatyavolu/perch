"""perch-build test: build one of Perch's gtest binaries and run it."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

Suite = Literal["unit", "browser"]
SUITES: dict[str, str] = {"unit": "perch_unittests", "browser": "perch_browser_tests"}
# Browser tests start whole browsers; more than two at once is too much for a laptop.
LAUNCHER_JOBS = 2
DEFAULT_FILTER = "*"


def suite_target(suite: Suite) -> str:
    return SUITES[suite]


def suite_command(out: Path, suite: Suite, gtest_filter: str = DEFAULT_FILTER) -> list[str]:
    """The command that runs a built suite: two launcher jobs, and headless for browser tests."""
    cmd = [str(out / SUITES[suite]), f"--test-launcher-jobs={LAUNCHER_JOBS}", f"--gtest_filter={gtest_filter}"]
    return [*cmd, "--headless=new"] if suite == "browser" else cmd
