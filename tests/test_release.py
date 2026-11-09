import shutil
from pathlib import Path

import pytest

from conftest import TAG, Recorder, git
from perchtools.patching import apply_series
from perchtools.release import appcast, preflight, publish, published_build_from_appcast, release_assets, release_notes
from perchtools.sbom import Finding, SbomError
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


def _preflight(repo, src, info=INFO, tag_exists=lambda tag: False, published=lambda: None, stale=lambda: [], findings=lambda: []):
    return preflight(repo, src, info, tag_exists, published, stale_policies=stale, vulnerabilities=findings)


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
    publish(INFO, [tmp_path / "Perch-0.1.0.dmg", tmp_path / "appcast.xml"], "notes", run=recorder)
    assert recorder.calls == [[
        "gh", "release", "create", "v0.1.0", "--repo", "neelsatyavolu/perch", "--title", "Perch 0.1.0",
        "--notes", "notes", str(tmp_path / "Perch-0.1.0.dmg"), str(tmp_path / "appcast.xml"),
    ]]


FINDING = Finding("GHSA-aaaa-bbbb-cccc", ("CVE-2026-1",), "smol-toml", "1.9.1")


def test_preflight_refuses_stale_policy_files(setup):
    reasons = _preflight(*setup, stale=lambda: [Path("docs/enterprise/policies.md")])
    assert any("docs/enterprise/policies.md" in r and "perch-build policies generate" in r for r in reasons)


def test_preflight_refuses_unlisted_vulnerability(setup):
    reasons = _preflight(*setup, findings=lambda: [FINDING])
    assert any("GHSA-aaaa-bbbb-cccc in smol-toml 1.9.1" in r and "known-vulnerabilities.md" in r for r in reasons)


def _list_known(repo, row):
    (repo / "docs").mkdir(exist_ok=True)
    (repo / "docs" / "known-vulnerabilities.md").write_text(
        "# Known vulnerabilities\n\n| ID | Package | Reason | Date |\n|---|---|---|---|\n" + row + "\n"
    )
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "known")


def test_preflight_allows_listed_vulnerability(setup):
    repo, src = setup
    _list_known(repo, "| CVE-2026-1 | smol-toml | Perch never parses untrusted TOML | 2026-11-07 |")
    assert _preflight(repo, src, findings=lambda: [FINDING]) == []


def test_preflight_refuses_listing_without_reason(setup):
    repo, src = setup
    _list_known(repo, "| GHSA-aaaa-bbbb-cccc | smol-toml |  | 2026-11-07 |")
    assert any("reason" in r for r in _preflight(repo, src, findings=lambda: [FINDING]))


def test_preflight_reports_a_failed_scan(setup):
    def broken():
        raise SbomError("osv-scanner exited 127")

    assert any("osv-scanner exited 127" in r for r in _preflight(*setup, findings=broken))


def test_release_notes_link_chrome_policies():
    notes = release_notes(INFO, [])
    assert "https://github.com/neelsatyavolu/perch/blob/v0.1.0/docs/enterprise/chrome-policies.md" in notes


def test_release_assets_include_pkg_only_when_built(tmp_path):
    dmg, pkg, feed, sbom = (tmp_path / n for n in ("Perch-0.1.0.dmg", "Perch-0.1.0.pkg", "appcast.xml", "Perch-0.1.0.spdx.json"))
    assert release_assets(dmg, pkg, feed, sbom) == [dmg, feed, sbom]
    pkg.write_text("pkg")
    assert release_assets(dmg, pkg, feed, sbom) == [dmg, pkg, feed, sbom]


def test_publish_uploads_five_files(tmp_path, recorder):
    names = ["Perch-0.1.0.dmg", "Perch-0.1.0.pkg", "appcast.xml", "Perch-0.1.0.spdx.json", "SHA256SUMS"]
    publish(INFO, [tmp_path / n for n in names], "notes", run=recorder)
    assert recorder.calls[0][-5:] == [str(tmp_path / n) for n in names]


def test_beta_appcast_marks_the_channel_and_keeps_published_items(tmp_path):
    dmg = tmp_path / "Perch-0.2.0.dmg"
    dmg.write_text("dmg")
    seen = {}

    class Keeping(AppcastRecorder):
        def __call__(self, cmd, **kwargs):
            if str(cmd[0]).endswith("generate_appcast"):
                from pathlib import Path

                seen["previous"] = (Path(str(cmd[-1])) / "appcast.xml").read_text()
            return super().__call__(cmd, **kwargs)

    recorder = Keeping()
    appcast(dmg, tmp_path / "release", "op://x", INFO, tmp_path / "bin", run=recorder, channel="beta", previous="<rss>stable</rss>")
    generate = recorder.calls[1]
    assert generate[generate.index("--channel") + 1] == "beta"
    assert seen["previous"] == "<rss>stable</rss>"


def test_stable_appcast_has_no_channel_and_unknown_channels_fail(tmp_path):
    dmg = tmp_path / "Perch-0.2.0.dmg"
    dmg.write_text("dmg")
    recorder = AppcastRecorder()
    appcast(dmg, tmp_path / "release", "op://x", INFO, tmp_path / "bin", run=recorder)
    assert "--channel" not in recorder.calls[1]
    with pytest.raises(ValueError, match="channel"):
        appcast(dmg, tmp_path / "r2", "op://x", INFO, tmp_path / "bin", run=recorder, channel="nightly")
