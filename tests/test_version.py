import pytest

from perchtools.version import VersionInfo, bump, bundle_versions, latest_stable_mac, read_version, write_version

STABLE = [{"channel": "Stable", "platform": "Mac", "version": "142.0.7444.59"}]


def test_latest_stable_mac_reads_chromiumdash():
    seen = []
    v = latest_stable_mac(lambda url: seen.append(url) or STABLE)
    assert v == "142.0.7444.59"
    assert seen == ["https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1"]


def test_latest_stable_mac_rejects_empty():
    with pytest.raises(ValueError):
        latest_stable_mac(lambda url: [])


def test_bump_rebase():
    assert bump(VersionInfo("0.1.3", 7, "142.0.7444.59"), "rebase", "143.0.7500.20") == VersionInfo("0.2.0", 8, "143.0.7500.20")


def test_bump_security():
    assert bump(VersionInfo("0.2.0", 8, "143.0.7500.20"), "security", "143.0.7500.31") == VersionInfo("0.2.1", 9, "143.0.7500.31")


def test_bump_perch_keeps_chromium():
    assert bump(VersionInfo("0.2.1", 9, "143.0.7500.31"), "perch") == VersionInfo("0.2.2", 10, "143.0.7500.31")


def test_bump_rebase_requires_chromium():
    with pytest.raises(ValueError):
        bump(VersionInfo("0.1.0", 1, "142.0.7444.59"), "rebase")


def test_bump_rejects_unknown_kind():
    with pytest.raises(ValueError):
        bump(VersionInfo("0.1.0", 1, "142.0.7444.59"), "major")


def test_bundle_versions():
    assert bundle_versions(VersionInfo("0.1.0", 1, "142.0.7444.59")) == {
        "CFBundleShortVersionString": "0.1.0",
        "CFBundleVersion": "1",
    }


def test_version_roundtrip(tmp_path):
    path = tmp_path / "version.json"
    info = VersionInfo("0.1.0", 1, "142.0.7444.59")
    write_version(path, info)
    assert read_version(path) == info


def test_read_version_rejects_bad_chromium(tmp_path):
    path = tmp_path / "version.json"
    path.write_text('{"perch": "0.1.0", "build": 1, "chromium": "latest"}')
    with pytest.raises(ValueError):
        read_version(path)
