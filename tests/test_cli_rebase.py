import json

import pytest

from perchtools import cli
from perchtools.patching import PatchFailed


@pytest.fixture
def repo(tmp_path, monkeypatch, paths):
    repo = tmp_path / "repo"
    (repo / "patches").mkdir(parents=True)
    (repo / "version.json").write_text(json.dumps({"perch": "0.1.3", "build": 7, "chromium": "158.0.8127.18"}))
    monkeypatch.setattr(cli, "REPO", repo)
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "fetch_json", lambda url: [{"version": "159.0.8200.10"}])
    return repo


def _version(repo):
    return json.loads((repo / "version.json").read_text())


def test_rebase_writes_version_before_checkout(repo, monkeypatch):
    seen = []

    def fake_checkout(paths, version, run):
        seen.append(("checkout", version, _version(repo)))

    monkeypatch.setattr(cli, "checkout", fake_checkout)
    monkeypatch.setattr(cli, "apply_series", lambda src, tag, *a: seen.append(("apply", tag)))
    assert cli.main(["rebase"]) == 0
    assert seen[0] == ("checkout", "159.0.8200.10", {"perch": "0.2.0", "build": 8, "chromium": "159.0.8200.10"})
    assert seen[1] == ("apply", "159.0.8200.10")


def test_security_rebase_bumps_patch(repo, monkeypatch):
    monkeypatch.setattr(cli, "checkout", lambda *a, **k: None)
    monkeypatch.setattr(cli, "apply_series", lambda *a: None)
    assert cli.main(["rebase", "--security", "158.0.8127.30"]) == 0
    assert _version(repo) == {"perch": "0.1.4", "build": 8, "chromium": "158.0.8127.30"}


def test_rebase_same_version_refuses(repo, monkeypatch, capsys):
    monkeypatch.setattr(cli, "checkout", lambda *a, **k: pytest.fail("must not check out"))
    assert cli.main(["rebase", "158.0.8127.18"]) == 1
    assert "already" in capsys.readouterr().err
    assert _version(repo)["build"] == 7


def test_rebase_failed_patch_exits_2_with_next_step(repo, monkeypatch, capsys):
    monkeypatch.setattr(cli, "checkout", lambda *a, **k: None)

    def failing(*a):
        raise PatchFailed("perch/branding/user-data-dir.patch", [])

    monkeypatch.setattr(cli, "apply_series", failing)
    assert cli.main(["rebase"]) == 2
    err = capsys.readouterr().err
    assert "perch/branding/user-data-dir.patch" in err and "perch-build apply --continue" in err
