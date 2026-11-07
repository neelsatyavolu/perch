"""Read bun.lock files: which packages a workspace ships, and what each depends on.

bun.lock is JSON with trailing commas. Packages are keyed by name; a copy
nested under another package is keyed "<parent>/<name>", and bun resolves a
dependency by looking from the most nested key outwards, as Node does.
Only dependencies and optionalDependencies count; devDependencies do not ship.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

RUNTIME_KEYS = ("dependencies", "optionalDependencies")


@dataclass(frozen=True)
class LockedPackage:
    key: str
    name: str
    spec: str
    integrity: str
    depends: tuple[str, ...]


def strip_trailing_commas(text: str) -> str:
    """Drop commas that come right before } or ], outside strings."""
    out: list[str] = []
    in_string = escaped = False
    pending_comma = ""
    for char in text:
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == ",":
            out.append(pending_comma)
            pending_comma = ","
            continue
        if char.isspace():
            if pending_comma:
                pending_comma += char
            else:
                out.append(char)
            continue
        if pending_comma:
            out.append(pending_comma.lstrip(",") if char in "}]" else pending_comma)
            pending_comma = ""
        if char == '"':
            in_string = True
        out.append(char)
    out.append(pending_comma)
    return "".join(out)


def load(path: Path) -> dict:
    return json.loads(strip_trailing_commas(path.read_text(encoding="utf-8")))


def _segments(key: str) -> list[str]:
    """Split a nested key into package names, keeping @scope/name together."""
    parts = key.split("/")
    names: list[str] = []
    while parts:
        part = parts.pop(0)
        names.append(f"{part}/{parts.pop(0)}" if part.startswith("@") and parts else part)
    return names


def resolve(packages: Mapping[str, list], parent: str | None, dep: str) -> str | None:
    """The key bun uses for dep when parent (None for a workspace) requires it."""
    segments = _segments(parent) if parent else []
    for depth in range(len(segments), 0, -1):
        candidate = "/".join([*segments[:depth], dep])
        if candidate in packages:
            return candidate
    return dep if dep in packages else None


def _runtime_deps(meta: Mapping[str, object]) -> list[str]:
    return [name for key in RUNTIME_KEYS for name in meta.get(key, {}) or {}]


def _locked(packages: Mapping[str, list], key: str) -> LockedPackage:
    entry = packages[key]
    ident = entry[0]
    name, _, spec = ident.rpartition("@")
    meta = next((part for part in entry[1:] if isinstance(part, dict)), {})
    integrity = entry[-1] if isinstance(entry[-1], str) and entry[-1].startswith("sha") else ""
    depends = tuple(found for dep in _runtime_deps(meta) if (found := resolve(packages, key, dep)))
    return LockedPackage(key=key, name=name, spec=spec, integrity=integrity, depends=depends)


def shipped(lock: Mapping[str, object]) -> list[LockedPackage]:
    """Every package the workspaces need at run time, roots first."""
    packages = lock.get("packages", {})
    queue = [
        found
        for workspace in lock.get("workspaces", {}).values()
        for dep in _runtime_deps(workspace)
        if (found := resolve(packages, None, dep))
    ]
    seen: dict[str, LockedPackage] = {}
    while queue:
        key = queue.pop(0)
        if key in seen:
            continue
        locked = _locked(packages, key)
        if locked.spec.startswith("workspace:"):
            continue
        seen[key] = locked
        queue += [dep for dep in locked.depends if dep not in seen]
    return list(seen.values())
