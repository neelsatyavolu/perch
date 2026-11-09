"""Compose args.gn from build/args/*.gn and run gn and autoninja."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Literal

from .checkout import depot_env
from .paths import Paths
from .run import run as default_run

Config = Literal["dev", "release"]
TARGETS: dict[str, list[str]] = {"dev": ["chrome"], "release": ["chrome", "chrome/installer/mac"]}
# Short names for Perch's test targets; any other --target goes to autoninja as given.
PERCH_TARGETS = {
    "perch_unittests": "chrome/browser/perch:perch_unittests",
    "perch_browser_tests": "chrome/browser/perch:perch_browser_tests",
}
# A full Chromium build at 18 parallel jobs overheated and shut down the owner's MacBook.
# Default to 6 local jobs at low priority; raise with --jobs when the Mac is plugged in and idle.
DEFAULT_JOBS = 6
NICENESS = "15"


def _strip_comment(line: str) -> str:
    in_quotes = False
    for index, char in enumerate(line):
        if char == '"':
            in_quotes = not in_quotes
        elif char == "#" and not in_quotes:
            return line[:index]
    return line


def _parse(path: Path) -> list[tuple[str, str]]:
    pairs = []
    for raw in path.read_text().splitlines():
        line = _strip_comment(raw).strip()
        if not line:
            continue
        name, sep, value = line.partition("=")
        if not sep:
            raise ValueError(f"{path}: expected 'name = value', got {raw!r}")
        pairs.append((name.strip(), value.strip()))
    return pairs


def compose_args(repo: Path, config: Config, overrides: Mapping[str, str] = {}) -> str:
    args_dir = repo / "build" / "args"
    merged: dict[str, str] = {}
    for name, value in _parse(args_dir / "common.gn") + _parse(args_dir / f"{config}.gn") + list(overrides.items()):
        merged[name] = value
    return "".join(f"{name} = {value}\n" for name, value in merged.items())


def ninja_target(target: str) -> str:
    """The autoninja target for a --target value: Perch's test targets by short name, else as given."""
    return PERCH_TARGETS.get(target, target)


def build(paths: Paths, config: Config, run=default_run, jobs: int = DEFAULT_JOBS, targets: Sequence[str] = ()) -> Path:
    """gn gen, then autoninja the given targets, or the config's default targets when none are given."""
    out = paths.out(config)
    out.mkdir(parents=True, exist_ok=True)
    args_gn = out / "args.gn"
    text = compose_args(paths.repo, config)
    if not args_gn.exists() or args_gn.read_text() != text:
        args_gn.write_text(text)
    env = depot_env(paths)
    run(["gn", "gen", out], cwd=paths.src, env=env)
    run(["nice", "-n", NICENESS, "autoninja", "-C", out, "-local_jobs", str(jobs),
         *([ninja_target(t) for t in targets] or TARGETS[config])], cwd=paths.src, env=env)
    return out
