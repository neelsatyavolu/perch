import subprocess

from perchtools import cli
from perchtools.gnargs import build


def test_build_target_defaults_to_chrome(paths, recorder):
    build(paths, "dev", run=recorder)
    assert recorder.calls[1][-1] == "chrome"


def test_build_target_named(paths, recorder):
    build(paths, "dev", run=recorder, targets=["perch_browser_tests"])
    assert recorder.calls[1][-1] == "chrome/browser/perch:perch_browser_tests"
    assert "chrome" not in recorder.calls[1]


def test_build_other_targets_pass_through(monkeypatch, paths, recorder):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["build", "--target", "chrome", "--target", "perch_unittests"]) == 0
    assert recorder.calls[-1][-2:] == ["chrome", "chrome/browser/perch:perch_unittests"]


def test_build_without_target_keeps_release_defaults(monkeypatch, paths, recorder):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["build", "--config", "release"]) == 0
    assert recorder.calls[-1][-2:] == ["chrome", "chrome/installer/mac"]


def test_test_command_builds_then_runs_unit_tests(monkeypatch, paths, recorder):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["test"]) == 0
    autoninja, binary = recorder.calls[-2:]
    assert autoninja[-1] == "chrome/browser/perch:perch_unittests"
    out = paths.out("dev")
    assert binary == [str(out / "perch_unittests"), "--test-launcher-jobs=2", "--gtest_filter=*"]


def test_test_command_caps_jobs_and_adds_headless(monkeypatch, paths, recorder):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", recorder)
    assert cli.main(["test", "browser", "--filter", "Perch*"]) == 0
    binary = recorder.calls[-1]
    assert binary[0] == str(paths.out("dev") / "perch_browser_tests")
    assert "--test-launcher-jobs=2" in binary and "--gtest_filter=Perch*" in binary and "--headless=new" in binary


def test_test_command_returns_the_suite_exit_code(monkeypatch, paths):
    def fake_run(cmd, **kwargs):
        code = 1 if str(cmd[0]).endswith("perch_unittests") else 0
        return subprocess.CompletedProcess(cmd, code, stdout="", stderr="")

    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", fake_run)
    assert cli.main(["test", "unit"]) == 1
