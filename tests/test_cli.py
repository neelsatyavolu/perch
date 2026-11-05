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



def test_doctor_exit_code_reflects_checks(monkeypatch, capsys, fake_probe_ok, paths):
    monkeypatch.setattr(cli, "SystemProbe", lambda: fake_probe_ok)
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    assert cli.main(["doctor"]) == 0
    fake_probe_ok.machine_name = "x86_64"
    assert cli.main(["doctor"]) == 1
    assert "FAIL arm64" in capsys.readouterr().out


def test_checkout_refuses_when_doctor_fails(monkeypatch, fake_probe_ok, paths, recorder):
    fake_probe_ok.machine_name = "x86_64"
    monkeypatch.setattr(cli, "SystemProbe", lambda: fake_probe_ok)
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["checkout"]) == 1
    assert recorder.calls == []


def _cli_repo(monkeypatch, tmp_path, chromium_like, patch_dirs):
    from perchtools.paths import Paths

    repo = patch_dirs["patches"].parent
    (repo / "version.json").write_text(json.dumps({"perch": "0.1.0", "build": 1, "chromium": "1.0.0.0"}))
    monkeypatch.setattr(cli, "REPO", repo)
    monkeypatch.setattr(cli, "GENERATORS", [])
    paths = Paths(repo=repo, chromium=chromium_like.parent, src=chromium_like, depot_tools=tmp_path / "dt")
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    return paths


def test_cli_apply_then_export(monkeypatch, tmp_path, chromium_like, patch_dirs):
    _cli_repo(monkeypatch, tmp_path, chromium_like, patch_dirs)
    assert cli.main(["apply"]) == 0
    assert (chromium_like / "d.txt").exists()
    assert cli.main(["export"]) == 0


def test_cli_apply_failure_exits_2_with_next_step(monkeypatch, tmp_path, capsys, chromium_like, patch_dirs):
    _cli_repo(monkeypatch, tmp_path, chromium_like, patch_dirs)
    two = patch_dirs["patches"] / "perch" / "two.patch"
    two.write_text(two.read_text().replace(" c2\n", " zz\n"))
    assert cli.main(["apply"]) == 2
    err = capsys.readouterr().err
    assert "perch/two.patch" in err and "perch-build apply --continue" in err
    assert cli.main(["apply", "--continue"]) == 2


def test_cli_build_uses_config(monkeypatch, paths, recorder):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["build", "--config", "release"]) == 0
    assert recorder.calls[-1][-2:] == ["chrome", "chrome/installer/mac"]
