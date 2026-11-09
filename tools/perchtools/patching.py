"""Apply Perch's changes to a Chromium tree as one git commit each.

Order: the overlay, then each patch in patches/series, then each generator.
Generated commits are named "perch-generated: <name>" and are never exported.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path

from .series import read_series

GENERATED = "perch-generated: "
BRANCH = "perch"
IDENTITY = ["-c", "user.name=Perch build", "-c", "user.email=build@perch.invalid"]

Generator = tuple[str, Callable[[Path], None]]


class PatchFailed(Exception):
    def __init__(self, patch: str, rejects: list[Path]):
        self.patch = patch
        self.rejects = rejects
        listed = "\n  ".join(str(r) for r in rejects) or "(no .rej files)"
        super().__init__(f"{patch} did not apply. Fix these, delete them, then run perch-build apply --continue:\n  {listed}")


def _git(src: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(src), *args], check=check, capture_output=True, text=True)


def _commit_if_changed(src: Path, message: str, *, allow_empty: bool = False) -> None:
    _git(src, "add", "-A")
    staged = _git(src, "diff", "--cached", "--quiet", check=False).returncode != 0
    if staged or allow_empty:
        _git(src, *IDENTITY, "commit", "-q", "--no-verify", "--allow-empty", "-m", message)


def _preamble(patch_text: str) -> str:
    """Text before the first diff header: the patch's comment."""
    head, sep, _ = patch_text.partition("diff --git ")
    return head.strip() if sep else ""


def _rejects(src: Path) -> list[Path]:
    listed = _git(src, "ls-files", "--others", "--exclude-standard", "--", "*.rej").stdout.split()
    return [src / name for name in listed]


def _copy_overlay(overlay_dir: Path, src: Path) -> None:
    if not overlay_dir.is_dir():
        return
    for path in sorted(overlay_dir.rglob("*")):
        if path.is_file() and path.name != ".keep":
            target = src / path.relative_to(overlay_dir)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def _run_from(src: Path, tag: str, patches_dir: Path, names: Sequence[str], generators: Sequence[Generator], state_file: Path) -> None:
    for index, name in enumerate(names):
        patch = patches_dir / name
        if _git(src, "apply", "--index", str(patch), check=False).returncode != 0:
            _git(src, "apply", "--reject", str(patch), check=False)
            state_file.write_text(json.dumps({"tag": tag, "failed": name, "remaining": list(names[index + 1 :])}, indent=2))
            raise PatchFailed(name, _rejects(src))
        message = name
        preamble = _preamble(patch.read_text())
        if preamble:
            message = f"{name}\n\n{preamble}"
        _commit_if_changed(src, message, allow_empty=True)
    for gen_name, generate in generators:
        generate(src)
        _commit_if_changed(src, GENERATED + gen_name)
    state_file.unlink(missing_ok=True)


def apply_series(src: Path, tag: str, patches_dir: Path, overlay_dir: Path, generators: Sequence[Generator], state_file: Path) -> None:
    names = read_series(patches_dir / "series")
    _git(src, "checkout", "-q", "-f", "-B", BRANCH, tag)
    _git(src, "clean", "-fdq")
    _copy_overlay(overlay_dir, src)
    _commit_if_changed(src, GENERATED + "overlay")
    _run_from(src, tag, patches_dir, names, generators, state_file)


def continue_series(src: Path, patches_dir: Path, generators: Sequence[Generator], state_file: Path) -> None:
    if not state_file.exists():
        raise FileNotFoundError(f"nothing to continue: {state_file} does not exist")
    state = json.loads(state_file.read_text())
    rejects = _rejects(src)
    if rejects:
        raise PatchFailed(state["failed"], rejects)
    failed = state["failed"]
    preamble = _preamble((patches_dir / failed).read_text())
    _commit_if_changed(src, f"{failed}\n\n{preamble}" if preamble else failed, allow_empty=True)
    _run_from(src, state["tag"], patches_dir, state["remaining"], generators, state_file)


def export_series(src: Path, tag: str, patches_dir: Path) -> list[Path]:
    """Write each patch commit on the perch branch back to patches_dir."""
    commits = _git(src, "rev-list", "--reverse", f"{tag}..{BRANCH}").stdout.split()
    written: list[Path] = []
    for commit in commits:
        subject = _git(src, "log", "-1", "--format=%s", commit).stdout.strip()
        if subject.startswith(GENERATED):
            continue
        body = _git(src, "log", "-1", "--format=%b", commit).stdout.strip()
        diff = _git(src, "diff", "--no-color", "--no-ext-diff", "--binary", f"{commit}^", commit).stdout
        target = patches_dir / subject
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"{body}\n{diff}" if body else diff)
        written.append(target)
    return written
