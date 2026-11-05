"""Compose args.gn from build/args/*.gn and run gn and autoninja."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from .checkout import depot_env
from .paths import Paths
from .run import run as default_run

Config = Literal["dev", "release"]
TARGETS: dict[str, list[str]] = {"dev": ["chrome"], "release": ["chrome", "chrome/installer/mac"]}


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


def build(paths: Paths, config: Config, run=default_run) -> Path:
    out = paths.out(config)
    out.mkdir(parents=True, exist_ok=True)
    args_gn = out / "args.gn"
    text = compose_args(paths.repo, config)
    if not args_gn.exists() or args_gn.read_text() != text:
        args_gn.write_text(text)
    env = depot_env(paths)
    run(["gn", "gen", out], cwd=paths.src, env=env)
    run(["autoninja", "-C", out, *TARGETS[config]], cwd=paths.src, env=env)
    return out
