"""Release checks, the Sparkle appcast and the GitHub release."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path

from .patching import export_series
from .run import run as default_run
from .version import VersionInfo

REPO_SLUG = "neelsatyavolu/perch"
VERSION_RE = re.compile(r"<sparkle:version>\s*(\d+)\s*</sparkle:version>")


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=False)


def _stale_patches(repo: Path, src: Path, tag: str) -> bool:
    with tempfile.TemporaryDirectory() as scratch:
        exported = {p.relative_to(scratch).as_posix(): p.read_text() for p in export_series(src, tag, Path(scratch))}
    current = {
        p.relative_to(repo / "patches").as_posix(): p.read_text()
        for p in (repo / "patches").rglob("*.patch")
    }
    return exported != current


def preflight(
    repo: Path,
    src: Path,
    info: VersionInfo,
    tag_exists: Callable[[str], bool],
    published_build: Callable[[], int | None],
) -> list[str]:
    """Return every reason not to release; an empty list means go."""
    reasons: list[str] = []
    if _git(repo, "status", "--porcelain").stdout.strip():
        reasons.append("the Perch repo has uncommitted changes; commit them first")
    if _git(src, "merge-base", "--is-ancestor", info.chromium, "HEAD").returncode != 0:
        found = _git(src, "describe", "--tags", "--abbrev=0", "HEAD").stdout.strip() or "an unknown tag"
        reasons.append(f"the Chromium tree is on {found}, but version.json pins {info.chromium}; run perch-build checkout and apply")
    elif _stale_patches(repo, src, info.chromium):
        reasons.append("patches/ does not match the perch branch in the Chromium tree; run perch-build export and commit")
    tag = f"v{info.perch}"
    if tag_exists(tag):
        reasons.append(f"tag {tag} already exists on GitHub; bump the version")
    published = published_build()
    if published is not None and info.build <= published:
        reasons.append(f"build {info.build} is not higher than the published build {published}; Sparkle would skip it")
    return reasons


def published_build_from_appcast(xml: str) -> int | None:
    builds = [int(match) for match in VERSION_RE.findall(xml)]
    return max(builds) if builds else None


def release_notes(info: VersionInfo, patches: Sequence[str]) -> str:
    listed = "\n".join(f"- {name}" for name in patches) or "- none"
    return f"Perch {info.perch} on Chromium {info.chromium}.\n\nPatches applied to Chromium:\n{listed}\n"


def appcast(dmg: Path, out: Path, key_ref: str, info: VersionInfo, sparkle_bin: Path, run=default_run) -> Path:
    """Write out/appcast.xml for dmg, EdDSA-signed with the key at key_ref in 1Password."""
    out.mkdir(parents=True, exist_ok=True)
    archives = out / "archives"
    shutil.rmtree(archives, ignore_errors=True)
    archives.mkdir()
    shutil.copy2(dmg, archives / dmg.name)
    prefix = f"https://github.com/{REPO_SLUG}/releases/download/v{info.perch}/"
    with tempfile.TemporaryDirectory() as secrets_dir:
        os.chmod(secrets_dir, 0o700)
        key_file = Path(secrets_dir) / "sparkle.key"
        run(["op", "read", "--out-file", key_file, key_ref])
        os.chmod(key_file, 0o600)
        run([sparkle_bin / "generate_appcast", "--ed-key-file", key_file, "--download-url-prefix", prefix, archives])
    target = out / "appcast.xml"
    shutil.move(archives / "appcast.xml", target)
    return target


def publish(info: VersionInfo, dmg: Path, appcast_path: Path, notes: str, run=default_run) -> None:
    run(["gh", "release", "create", f"v{info.perch}", "--repo", REPO_SLUG, "--title", f"Perch {info.perch}",
         "--notes", notes, dmg, appcast_path])
