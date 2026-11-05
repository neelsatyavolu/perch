"""The patches/series file: which patches apply, in which order."""

from __future__ import annotations

from pathlib import Path


class SeriesError(Exception):
    pass


def read_series(path: Path) -> list[str]:
    """Return the patch names listed in path, relative to its folder."""
    if not path.exists():
        return []
    names: list[str] = []
    for raw in path.read_text().splitlines():
        name = raw.strip()
        if not name or name.startswith("#"):
            continue
        if name in names:
            raise SeriesError(f"{path}: {name} is listed twice")
        if not (path.parent / name).is_file():
            raise SeriesError(f"{path}: {name} is listed but the file does not exist")
        names.append(name)
    return names
