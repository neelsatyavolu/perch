"""Where the Perch repo, the Chromium checkout and depot_tools live."""

from __future__ import annotations

import json
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


LOCAL_FILE = "perch-build.local.json"


def load_paths(env: Mapping[str, str], repo: Path = REPO) -> Paths:
    """Locations come from the environment, then perch-build.local.json in the repo, then defaults."""
    home = Path(env["HOME"])
    local_file = repo / LOCAL_FILE
    local = json.loads(local_file.read_text()) if local_file.exists() else {}
    chromium = Path(env.get("PERCH_CHROMIUM_DIR") or local.get("chromium") or home / "chromium-perch")
    depot_tools = Path(env.get("PERCH_DEPOT_TOOLS") or local.get("depot_tools") or home / "depot_tools")
    return Paths(repo=repo, chromium=chromium, src=chromium / "src", depot_tools=depot_tools)
