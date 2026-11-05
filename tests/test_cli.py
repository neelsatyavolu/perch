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


def test_cli_package_release_without_creds_explains(monkeypatch, capsys, paths):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    for name in ["APPLE_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]:
        monkeypatch.delenv(name, raising=False)
    assert cli.main(["package", "--mode", "release"]) == 1
    assert "scripts/with-apple-creds.sh" in capsys.readouterr().err


def test_cli_package_adhoc_needs_no_creds(monkeypatch, paths):
    seen = {}
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "package", lambda p, info, mode, creds, run: seen.update(mode=mode, creds=creds) or p.repo / "x.dmg")
    assert cli.main(["package", "--mode", "adhoc"]) == 0
    assert seen == {"mode": "adhoc", "creds": None}


def _release_env(monkeypatch, tmp_path, paths, reasons):
    repo = tmp_path / "repo"
    (repo / "dist").mkdir(parents=True)
    (repo / "dist" / "Perch-0.1.0.dmg").write_text("dmg")
    (repo / "patches").mkdir()
    (repo / "patches" / "series").write_text("")
    (repo / "version.json").write_text(json.dumps({"perch": "0.1.0", "build": 1, "chromium": "158.0.8127.18"}))
    monkeypatch.setattr(cli, "REPO", repo)
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setenv("PERCH_SPARKLE_KEY_REF", "op://Private/k/key")
    monkeypatch.setattr(cli, "preflight", lambda *a: reasons)
    monkeypatch.setattr(cli, "sparkle_bin", lambda repo: tmp_path / "bin")
    monkeypatch.setattr(cli, "appcast", lambda dmg, out, key_ref, info, bin_dir, run: out / "appcast.xml")
    published = []
    monkeypatch.setattr(cli, "publish", lambda *a, **k: published.append(a))
    return published


def test_cli_release_dry_run_publishes_nothing(monkeypatch, tmp_path, paths, capsys):
    published = _release_env(monkeypatch, tmp_path, paths, ["the Perch repo has uncommitted changes; commit them first"])
    assert cli.main(["release", "--dry-run"]) == 0
    assert published == []
    assert "uncommitted" in capsys.readouterr().err


def test_cli_release_refuses_on_preflight(monkeypatch, tmp_path, paths):
    published = _release_env(monkeypatch, tmp_path, paths, ["tag v0.1.0 already exists on GitHub; bump the version"])
    assert cli.main(["release"]) == 1
    assert published == []


def test_cli_release_publishes(monkeypatch, tmp_path, paths):
    published = _release_env(monkeypatch, tmp_path, paths, [])
    assert cli.main(["release"]) == 0
    assert len(published) == 1


def test_cli_release_needs_package_first(monkeypatch, tmp_path, paths, capsys):
    _release_env(monkeypatch, tmp_path, paths, [])
    (tmp_path / "repo" / "dist" / "Perch-0.1.0.dmg").unlink()
    assert cli.main(["release"]) == 1
    assert "perch-build package" in capsys.readouterr().err


def test_cli_build_jobs_flag(monkeypatch, paths, recorder):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["build", "--jobs", "3"]) == 0
    assert "3" == recorder.calls[-1][recorder.calls[-1].index("-local_jobs") + 1]
