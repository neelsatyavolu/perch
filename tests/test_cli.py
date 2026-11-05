import json

from perchtools import cli


def test_version_prints(tmp_path, capsys, monkeypatch):
    (tmp_path / "version.json").write_text(json.dumps({"perch": "0.1.0", "build": 1, "chromium": "142.0.7444.59"}))
    monkeypatch.setattr(cli, "REPO", tmp_path)
    assert cli.main(["version"]) == 0
    assert capsys.readouterr().out.strip() == "Perch 0.1.0 (build 1) on Chromium 142.0.7444.59"


def test_version_bump_perch(tmp_path, monkeypatch):
    (tmp_path / "version.json").write_text(json.dumps({"perch": "0.1.0", "build": 1, "chromium": "142.0.7444.59"}))
    monkeypatch.setattr(cli, "REPO", tmp_path)
    assert cli.main(["version", "--bump", "perch"]) == 0
    assert json.loads((tmp_path / "version.json").read_text()) == {"perch": "0.1.1", "build": 2, "chromium": "142.0.7444.59"}


def test_version_set_latest(tmp_path, monkeypatch):
    (tmp_path / "version.json").write_text(json.dumps({"perch": "0.1.0", "build": 1, "chromium": "142.0.7444.59"}))
    monkeypatch.setattr(cli, "REPO", tmp_path)
    monkeypatch.setattr(cli, "fetch_json", lambda url: [{"version": "142.0.7444.70"}])
    assert cli.main(["version", "--set-latest"]) == 0
    assert json.loads((tmp_path / "version.json").read_text())["chromium"] == "142.0.7444.70"
