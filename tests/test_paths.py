from pathlib import Path

from perchtools.paths import load_paths


def test_defaults(tmp_path):
    paths = load_paths({"HOME": str(tmp_path)})
    assert paths.chromium == tmp_path / "chromium-perch"
    assert paths.src == tmp_path / "chromium-perch" / "src"
    assert paths.depot_tools == tmp_path / "depot_tools"
    assert paths.out("release") == tmp_path / "chromium-perch" / "src" / "out" / "Release"
    assert paths.out("dev") == tmp_path / "chromium-perch" / "src" / "out" / "Dev"


def test_env_overrides(tmp_path):
    paths = load_paths({"HOME": str(tmp_path), "PERCH_CHROMIUM_DIR": "/x/cr", "PERCH_DEPOT_TOOLS": "/x/dt"})
    assert paths.chromium == Path("/x/cr")
    assert paths.src == Path("/x/cr/src")
    assert paths.depot_tools == Path("/x/dt")


def test_repo_is_this_checkout():
    paths = load_paths({"HOME": "/h"})
    assert (paths.repo / "pyproject.toml").exists()
