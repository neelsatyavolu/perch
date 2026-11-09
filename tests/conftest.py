import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from perchtools.paths import Paths

GIB = 1024**3


@dataclass
class FakeProbe:
    machine_name: str = "arm64"
    xcode: str = "/Applications/Xcode.app/Contents/Developer"
    free: int = 300 * GIB
    present: set = field(default_factory=set)
    python: tuple = (3, 13)

    def machine(self) -> str:
        return self.machine_name

    def xcode_path(self) -> str:
        return self.xcode

    def free_bytes(self, path: Path) -> int:
        return self.free

    def exists(self, path: Path) -> bool:
        return path in self.present

    def python_version(self) -> tuple:
        return self.python


class Recorder:
    """Stands in for run(): records each command and succeeds."""

    def __init__(self):
        self.calls = []
        self.kwargs = []

    def __call__(self, cmd, **kwargs):
        self.calls.append([str(c) for c in cmd])
        self.kwargs.append(kwargs)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


@pytest.fixture
def paths(tmp_path):
    chromium = tmp_path / "chromium-perch"
    return Paths(repo=Path(__file__).resolve().parents[1], chromium=chromium, src=chromium / "src", depot_tools=tmp_path / "depot_tools")


@pytest.fixture
def fake_probe_ok(paths):
    return FakeProbe(present={paths.depot_tools})


@pytest.fixture
def recorder():
    return Recorder()


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


TAG = "1.0.0.0"


@pytest.fixture
def chromium_like(tmp_path):
    """A small git repo shaped like the Chromium src checkout, tagged 1.0.0.0."""
    src = tmp_path / "chromium" / "src"
    (src / "b").mkdir(parents=True)
    (src / "a.txt").write_text("alpha\n")
    (src / "b" / "c.txt").write_text("c1\nc2\n")
    (src / ".gitignore").write_text("out/\n")
    git(src.parent, "init", "-q", "src")
    git(src, "add", "-A")
    git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
    git(src, "tag", TAG)
    return src


def make_patch(src, edit):
    """Run edit(src) on a clean tree and return the resulting diff, then undo it."""
    edit(src)
    git(src, "add", "-A")
    diff = git(src, "diff", "--cached", "--no-color")
    git(src, "reset", "-q", "--hard")
    git(src, "clean", "-fdq")
    return diff


@pytest.fixture
def patch_dirs(chromium_like, tmp_path):
    src = chromium_like
    patches = tmp_path / "patches"
    (patches / "perch").mkdir(parents=True)
    (patches / "perch" / "one.patch").write_text(
        "# Perch: why one exists\n" + make_patch(src, lambda s: (s / "a.txt").write_text("alpha\none\n"))
    )
    (patches / "perch" / "two.patch").write_text(make_patch(src, lambda s: (s / "b" / "c.txt").write_text("c1\nc2\ntwo\n")))
    (patches / "perch" / "three.patch").write_text(make_patch(src, lambda s: (s / "d.txt").write_text("delta\n")))
    (patches / "series").write_text("# order matters\nperch/one.patch\n\nperch/two.patch\nperch/three.patch\n")
    overlay = tmp_path / "overlay"
    (overlay / "b").mkdir(parents=True)
    (overlay / "b" / "new.txt").write_text("from overlay\n")
    (overlay / ".keep").write_text("")
    return {"patches": patches, "overlay": overlay, "state": tmp_path / "chromium" / "perch-apply-state.json"}


@pytest.fixture(autouse=True)
def _no_component_check(request, monkeypatch):
    """CLI tests use a fake checkout without registration.cc; test_components covers the check."""
    if request.module.__name__.endswith("test_components"):
        return
    from perchtools import cli

    monkeypatch.setattr(cli, "_component_reasons", lambda paths: [])
    # No test reaches 1Password.
    monkeypatch.setattr(cli, "_read_secret", lambda ref: None)
    monkeypatch.delenv("PERCH_GOOGLE_API_KEY", raising=False)
