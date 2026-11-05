"""Where the Perch repo, the Chromium checkout and depot_tools live."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Paths:
    repo: Path
    chromium: Path
    src: Path
    depot_tools: Path

    def out(self, config: str) -> Path:
        return self.src / "out" / config.capitalize()


def load_paths(env: Mapping[str, str]) -> Paths:
    home = Path(env["HOME"])
    chromium = Path(env.get("PERCH_CHROMIUM_DIR") or home / "chromium-perch")
    depot_tools = Path(env.get("PERCH_DEPOT_TOOLS") or home / "depot_tools")
    return Paths(repo=REPO, chromium=chromium, src=chromium / "src", depot_tools=depot_tools)
