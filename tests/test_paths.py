from pathlib import Path

from perchtools.paths import load_paths


def test_defaults(tmp_path):
    paths = load_paths({"HOME": str(tmp_path)}, repo=tmp_path)
    assert paths.chromium == tmp_path / "chromium-perch"
    assert paths.src == tmp_path / "chromium-perch" / "src"
    assert paths.depot_tools == tmp_path / "depot_tools"
    assert paths.out("release") == tmp_path / "chromium-perch" / "src" / "out" / "Release"
    assert paths.out("dev") == tmp_path / "chromium-perch" / "src" / "out" / "Dev"


def test_env_overrides(tmp_path):
    paths = load_paths({"HOME": str(tmp_path), "PERCH_CHROMIUM_DIR": "/x/cr", "PERCH_DEPOT_TOOLS": "/x/dt"}, repo=tmp_path)
    assert paths.chromium == Path("/x/cr")
    assert paths.src == Path("/x/cr/src")
    assert paths.depot_tools == Path("/x/dt")


def test_repo_is_this_checkout():
    paths = load_paths({"HOME": "/h"})
    assert (paths.repo / "pyproject.toml").exists()


def test_local_file_sets_locations(tmp_path):
    (tmp_path / "perch-build.local.json").write_text('{"chromium": "/Users/Shared/chromium-perch", "depot_tools": "/opt/dt"}')
    paths = load_paths({"HOME": "/h"}, repo=tmp_path)
    assert paths.chromium == Path("/Users/Shared/chromium-perch")
    assert paths.depot_tools == Path("/opt/dt")


def test_env_beats_local_file(tmp_path):
    (tmp_path / "perch-build.local.json").write_text('{"chromium": "/Users/Shared/chromium-perch"}')
    paths = load_paths({"HOME": "/h", "PERCH_CHROMIUM_DIR": "/x/cr"}, repo=tmp_path)
    assert paths.chromium == Path("/x/cr")
