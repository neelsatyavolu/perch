import shutil

import pytest

from conftest import TAG, Recorder, git
from perchtools.patching import apply_series
from perchtools.release import appcast, preflight, publish, published_build_from_appcast, release_notes
from perchtools.version import VersionInfo

INFO = VersionInfo("0.1.0", 1, TAG)


@pytest.fixture
def setup(tmp_path, chromium_like, patch_dirs):
    repo = tmp_path / "repo"
    repo.mkdir()
    shutil.copytree(patch_dirs["patches"], repo / "patches")
    git(tmp_path, "init", "-q", "repo")
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    apply_series(chromium_like, TAG, repo / "patches", patch_dirs["overlay"], [], patch_dirs["state"])
    return repo, chromium_like


def _preflight(repo, src, info=INFO, tag_exists=lambda tag: False, published=lambda: None):
    return preflight(repo, src, info, tag_exists, published)


def test_preflight_clean_passes(setup):
    assert _preflight(*setup) == []


def test_preflight_dirty_repo(setup):
    repo, src = setup
    (repo / "stray.txt").write_text("x")
    assert any("uncommitted" in reason for reason in _preflight(repo, src))


def test_preflight_wrong_chromium(setup):
    repo, src = setup
    reasons = _preflight(repo, src, VersionInfo("0.1.0", 1, "9.9.9.9"))
    assert any("9.9.9.9" in r and TAG in r for r in reasons)


def test_preflight_stale_patches(setup):
    repo, src = setup
    (src / "d.txt").write_text("delta\nchanged\n")
    git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qa", "--amend", "--no-edit")
    assert any("perch-build export" in r for r in _preflight(repo, src))


def test_preflight_tag_exists(setup):
    assert any("v0.1.0" in r for r in _preflight(*setup, tag_exists=lambda tag: tag == "v0.1.0"))


def test_preflight_build_not_higher(setup):
    repo, src = setup
    reasons = _preflight(repo, src, VersionInfo("0.1.0", 3, TAG), published=lambda: 3)
    assert any("build 3" in r for r in reasons)
    assert _preflight(repo, src, VersionInfo("0.1.0", 4, TAG), published=lambda: 3) == []


def test_published_build_from_appcast():
    xml = "<rss><channel><item><sparkle:version>2</sparkle:version></item><item><sparkle:version>7</sparkle:version></item></channel></rss>"
    assert published_build_from_appcast(xml) == 7
    assert published_build_from_appcast("<rss></rss>") is None


class AppcastRecorder(Recorder):
    """Pretends to be op and generate_appcast: writes the files they would write."""

    def __call__(self, cmd, **kwargs):
        cmd = [str(c) for c in cmd]
        if cmd[0] == "op":
            open(cmd[cmd.index("--out-file") + 1], "w").write("private-key")
        if cmd[0].endswith("generate_appcast"):
            from pathlib import Path

            (Path(cmd[-1]) / "appcast.xml").write_text("<rss/>")
        return super().__call__(cmd, **kwargs)


def test_appcast_key_file_removed(tmp_path):
    dmg = tmp_path / "Perch-0.1.0.dmg"
    dmg.write_text("dmg")
    recorder = AppcastRecorder()
    out = appcast(dmg, tmp_path / "release", "op://Private/Perch Sparkle/key", INFO, tmp_path / "bin", run=recorder)
    assert out == tmp_path / "release" / "appcast.xml" and out.read_text() == "<rss/>"
    generate = recorder.calls[1]
    key_file = generate[generate.index("--ed-key-file") + 1]
    from pathlib import Path

    assert not Path(key_file).exists()
    assert "--download-url-prefix" in generate
    assert generate[generate.index("--download-url-prefix") + 1] == "https://github.com/neelsatyavolu/perch/releases/download/v0.1.0/"


def test_release_notes_list_patches():
    notes = release_notes(INFO, ["perch/branding/branding-file.patch"])
    assert f"Chromium {TAG}" in notes and "- perch/branding/branding-file.patch" in notes


def test_publish_creates_release(tmp_path, recorder):
    publish(INFO, tmp_path / "Perch-0.1.0.dmg", tmp_path / "appcast.xml", "notes", run=recorder)
    assert recorder.calls == [[
        "gh", "release", "create", "v0.1.0", "--repo", "neelsatyavolu/perch", "--title", "Perch 0.1.0",
        "--notes", "notes", str(tmp_path / "Perch-0.1.0.dmg"), str(tmp_path / "appcast.xml"),
    ]]
