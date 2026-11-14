"""Build the extensions Perch ships built in and stage them for the browser.

Each entry in build/bundled-extensions.json is Perch's own extension (a folder in this repo),
another open-source extension pinned to a commit, or a built release asset pinned by its address and
SHA-256 (a changed or tampered download fails the build). A release can't be patched, so Perch adds
`manifest` keys to it instead (the extension's own switches for embedding) and can turn its
declarativeNetRequest rulesets off (`disable_rulesets`), since Perch has its own blocker. Pinned ones are checked out into a cache, never
built in their own working copy. Before the build, files named in `stubs` are replaced with Perch's
versions from extension/bundled/ (the usage pings, since Perch sends nothing by default) and `edits`
change exact strings (hiding the ping's switch). The result lands in out/<config>/perch_extensions/
<name>, with the fixed public key that gives each one a stable id.

An entry with `updates` also updates between Perch releases from its GitHub releases: staging
writes out/<config>/perch_extensions/updates.json with the Ed25519 public key that release zips
must be signed with (scripts/sign-extension-release.ts) and what the browser needs to rebuild the
manifest the way write_manifest does (overlay/.../perch_extension_updates.cc).
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import urllib.request
import zipfile
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
    release: dict[str, str] | None = None
    manifest: dict[str, Any] = field(default_factory=dict)
    disable_rulesets: bool = False
    updates: dict[str, str] | None = None

    @staticmethod
    def from_json(raw: Mapping[str, Any]) -> Bundled:
        b = Bundled(
            name=raw["name"], id=raw["id"], key=raw["key"], dist=raw["dist"], incognito=bool(raw["incognito"]),
            source=raw.get("source"), repo=raw.get("repo"), commit=raw.get("commit"),
            install=raw.get("install"), build=raw.get("build"),
            stubs=dict(raw.get("stubs", {})), edits=list(raw.get("edits", [])),
            exclude=list(raw.get("exclude", [])),
            release=dict(raw["release"]) if raw.get("release") else None,
            manifest=dict(raw.get("manifest", {})), disable_rulesets=bool(raw.get("disable_rulesets", False)),
            updates=dict(raw["updates"]) if raw.get("updates") else None,
        )
        if [b.source, b.repo, b.release].count(None) != 2:
            raise StageError(f"{b.name}: give exactly one of a source folder, a repo or a release")
        if b.release:
            url, digest = b.release.get("url", ""), b.release.get("sha256", "")
            if not url.startswith("https://") or len(digest) != 64:
                raise StageError(f"{b.name}: a release needs an https url and its sha256")
            if b.stubs or b.edits or b.build or b.install:
                raise StageError(f"{b.name}: a built release can't take stubs, edits or a build")
        if b.updates and not (b.updates.get("repo", "").count("/") == 1 and b.updates.get("asset")):
            raise StageError(f"{b.name}: updates need a GitHub repo as owner/name and an asset name")
        if b.repo and not (b.commit and len(b.commit) == 40):
            raise StageError(f"{b.name}: a repo needs a full 40-character commit")
        return b


def load_bundled(path: Path) -> list[Bundled]:
    return [Bundled.from_json(raw) for raw in json.loads(path.read_text())["extensions"]]


def load_update_key(path: Path) -> str:
    """The base64 Ed25519 public key built-in extension releases are signed with."""
    key = json.loads(path.read_text()).get("update_public_key", "")
    if len(base64.b64decode(key, validate=True)) != 32:
        raise StageError(f"{path}: update_public_key must be a base64 Ed25519 public key")
    return key


def updates_config(bundled: Sequence[Bundled], public_key: str) -> dict[str, Any]:
    """updates.json: per updating extension, where its releases are and how Perch patches them."""
    return {
        "public_key": public_key,
        "extensions": [
            {
                "name": b.name, "repo": b.updates["repo"], "asset": b.updates["asset"],
                "root": b.updates.get("root", ""), "from_version": b.updates.get("from_version", ""),
                "key": b.key, "incognito": b.incognito, "manifest": b.manifest,
                "disable_rulesets": b.disable_rulesets,
            }
            for b in bundled if b.updates
        ],
    }


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
    manifest.update(b.manifest)
    manifest["key"] = b.key
    if b.disable_rulesets:
        for ruleset in manifest.get("declarative_net_request", {}).get("rule_resources", []):
            ruleset["enabled"] = False
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


def _download_release(b: Bundled, cache: Path, opener: Callable[[str], bytes]) -> Path:
    """Downloads the release asset (or reuses a cached copy with the same hash) and unpacks it."""
    assert b.release
    archive = cache / f"{b.name}-{b.release['sha256'][:16]}.zip"
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != b.release["sha256"]:
        data = opener(b.release["url"])
        got = hashlib.sha256(data).hexdigest()
        if got != b.release["sha256"]:
            raise StageError(f"{b.name}: the release download's sha256 is {got}, not the pinned {b.release['sha256']}")
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(data)
    dest = cache / f"{b.name}-release"
    shutil.rmtree(dest, ignore_errors=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            target = (dest / member).resolve()
            if not str(target).startswith(str(dest.resolve())):
                raise StageError(f"{b.name}: the release zip has a path outside its folder: {member}")
        z.extractall(dest)
    return dest


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 (https only, checked above)
        return response.read()


def stage_extensions(
    bundled: Sequence[Bundled], *, repo: Path, out: Path, cache: Path, local: Mapping[str, str], run: Run,
    fetch: Callable[[str], bytes] = _fetch, update_key: str = "",
) -> list[Path]:
    staged = []
    for b in bundled:
        if b.release:
            work = _download_release(b, cache, fetch)
        else:
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
    if update_key:
        (out / "updates.json").write_text(json.dumps(updates_config(bundled, update_key), indent=2) + "\n")
    return staged


KEYHELPER = Path("helpers") / "keyhelper"
KEYS_APP = "Perch Keys.app"


def stage_keyhelper(*, repo: Path, out: Path, run: Run) -> Path:
    """Build the Swift key helper and assemble out/Perch Keys.app (Contents/Info.plist and
    Contents/MacOS/PerchKeys). package.py copies it into the framework's Helpers and signs it."""
    package = repo / KEYHELPER
    build = ["swift", "build", "-c", "release", "--arch", "arm64", "--package-path", package]
    run(build)
    binary = Path(run([*build, "--show-bin-path"], capture=True).stdout.strip()) / "PerchKeys"
    if not binary.is_file():
        raise StageError(f"swift build did not produce {binary}")
    app = out / KEYS_APP
    shutil.rmtree(app, ignore_errors=True)
    (app / "Contents" / "MacOS").mkdir(parents=True)
    shutil.copyfile(package / "Info.plist", app / "Contents" / "Info.plist")
    shutil.copy2(binary, app / "Contents" / "MacOS" / "PerchKeys")
    return app
