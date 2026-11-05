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
