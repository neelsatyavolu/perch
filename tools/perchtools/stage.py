"""Build the extensions Perch ships built in and stage them for the browser.

Each entry in build/bundled-extensions.json is either Perch's own extension (a folder in this repo)
or another open-source extension pinned to a commit. Pinned ones are checked out into a cache, never
built in their own working copy. Before the build, files named in `stubs` are replaced with Perch's
versions from extension/bundled/ (the usage pings, since Perch sends nothing by default) and `edits`
change exact strings (hiding the ping's switch). The result lands in out/<config>/perch_extensions/
<name>, with the fixed public key that gives each one a stable id.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

BUNDLED_FILE = Path("build") / "bundled-extensions.json"
STUB_DIR = Path("extension") / "bundled"
Run = Callable[..., Any]


class StageError(RuntimeError):
    pass


@dataclass(frozen=True)
class Bundled:
    name: str
    id: str
    key: str
    dist: str
    incognito: bool
    source: str | None = None
    repo: str | None = None
    commit: str | None = None
    install: list[str] | None = None
    build: list[str] | None = None
    stubs: dict[str, str] = field(default_factory=dict)
    edits: list[dict[str, str]] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)

    @staticmethod
    def from_json(raw: Mapping[str, Any]) -> Bundled:
        b = Bundled(
            name=raw["name"], id=raw["id"], key=raw["key"], dist=raw["dist"], incognito=bool(raw["incognito"]),
            source=raw.get("source"), repo=raw.get("repo"), commit=raw.get("commit"),
            install=raw.get("install"), build=raw.get("build"),
            stubs=dict(raw.get("stubs", {})), edits=list(raw.get("edits", [])),
            exclude=list(raw.get("exclude", [])),
        )
        if (b.source is None) == (b.repo is None):
            raise StageError(f"{b.name}: give either a source folder or a repo")
        if b.repo and not (b.commit and len(b.commit) == 40):
            raise StageError(f"{b.name}: a repo needs a full 40-character commit")
        return b


def load_bundled(path: Path) -> list[Bundled]:
    return [Bundled.from_json(raw) for raw in json.loads(path.read_text())["extensions"]]


def apply_edits(root: Path, edits: Sequence[Mapping[str, str]]) -> None:
    for edit in edits:
        file = root / edit["file"]
        text = file.read_text()
        count = text.count(edit["find"])
        if count != 1:
            raise StageError(f"{edit['file']}: expected the text once, found it {count} times: {edit['find']!r}")
        file.write_text(text.replace(edit["find"], edit["replace"]))


def write_manifest(folder: Path, b: Bundled) -> None:
    path = folder / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest.pop("update_url", None)
    manifest["key"] = b.key
    if not b.incognito:
        manifest["incognito"] = "not_allowed"
    path.write_text(json.dumps(manifest, indent=2) + "\n")


def _checkout(b: Bundled, cache: Path, local: Mapping[str, str], run: Run) -> Path:
    dest = cache / b.name
    if not (dest / ".git").exists():
        shutil.rmtree(dest, ignore_errors=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--no-checkout", local.get(b.name) or b.repo, str(dest)])
    else:
        run(["git", "-C", str(dest), "fetch", "--quiet", "origin"])
    run(["git", "-C", str(dest), "checkout", "--force", "--detach", b.commit])
    run(["git", "-C", str(dest), "clean", "-fdq", "-e", "node_modules"])
    return dest


def stage_extensions(
    bundled: Sequence[Bundled], *, repo: Path, out: Path, cache: Path, local: Mapping[str, str], run: Run,
) -> list[Path]:
    staged = []
    for b in bundled:
        work = repo / b.source if b.source else _checkout(b, cache, local, run)
        for target, stub in b.stubs.items():
            shutil.copyfile(repo / STUB_DIR / stub, work / target)
        apply_edits(work, b.edits)
        if b.install:
            run(b.install, cwd=work)
        if b.build:
            run(b.build, cwd=work)
        dest = out / b.name
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(work / b.dist, dest, ignore=shutil.ignore_patterns(".git", "node_modules", ".*", *b.exclude))
        write_manifest(dest, b)
        staged.append(dest)
    return staged
