"""Checks that this Mac can check out and build Chromium."""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .paths import Paths

GIB = 1024**3
MIN_FREE_GIB = 120
MIN_PYTHON = (3, 12)
DEPOT_TOOLS_URL = "https://chromium.googlesource.com/chromium/tools/depot_tools.git"


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str


class Probe(Protocol):
    def machine(self) -> str: ...
    def xcode_path(self) -> str: ...
    def free_bytes(self, path: Path) -> int: ...
    def exists(self, path: Path) -> bool: ...
    def python_version(self) -> tuple[int, int]: ...


class SystemProbe:
    def machine(self) -> str:
        return platform.machine()

    def xcode_path(self) -> str:
        result = subprocess.run(["xcode-select", "-p"], capture_output=True, text=True, check=False)
        return result.stdout.strip()

    def free_bytes(self, path: Path) -> int:
        existing = path
        while not existing.exists():
            existing = existing.parent
        return shutil.disk_usage(existing).free

    def exists(self, path: Path) -> bool:
        return path.exists()

    def python_version(self) -> tuple[int, int]:
        return sys.version_info[:2]


def run_checks(probe: Probe, paths: Paths) -> list[Check]:
    machine = probe.machine()
    xcode = probe.xcode_path()
    free_gib = probe.free_bytes(paths.chromium) / GIB
    python = probe.python_version()
    has_depot_tools = probe.exists(paths.depot_tools)
    # TypeScript in the Chromium build reads @types from every node_modules above the checkout.
    stray = [d / "node_modules" for d in (paths.chromium, *paths.chromium.parents) if probe.exists(d / "node_modules")]
    return [
        Check("arm64", machine == "arm64", "Apple silicon" if machine == "arm64" else f"this Mac is {machine}; Perch builds on Apple silicon only"),
        Check("xcode", xcode.startswith("/Applications/Xcode"), xcode if xcode.startswith("/Applications/Xcode") else f"selected developer dir is {xcode or 'none'}; install Xcode and run xcode-select -s /Applications/Xcode.app"),
        Check("disk", free_gib >= MIN_FREE_GIB, f"{free_gib:.0f} GiB free" + ("" if free_gib >= MIN_FREE_GIB else f"; the checkout and builds need {MIN_FREE_GIB} GiB")),
        Check("python", python >= MIN_PYTHON, f"Python {python[0]}.{python[1]}" + ("" if python >= MIN_PYTHON else f"; needs {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer")),
        Check("node_modules", not stray, "none above the checkout" if not stray else f"{stray[0]} breaks Chromium's TypeScript build; put the checkout elsewhere with PERCH_CHROMIUM_DIR or perch-build.local.json, for example /Users/Shared/chromium-perch"),
        Check("depot_tools", has_depot_tools, f"found at {paths.depot_tools}" if has_depot_tools else f"missing; run: git clone {DEPOT_TOOLS_URL} {paths.depot_tools}"),
    ]
