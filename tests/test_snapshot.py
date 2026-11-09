import subprocess
from pathlib import Path

from perchtools import cli
from perchtools.snapshot import snapshot_command, written


def test_command_is_headless_in_a_throwaway_profile(tmp_path):
    cmd = snapshot_command(Path("/out/Perch.app"), Path("/repo"), tmp_path, Path("/tmp/p"),
                           ["tabs", "theme-dusk"], None)
    assert cmd[0] == "/out/Perch.app/Contents/MacOS/Perch"
    assert "--headless=new" in cmd and "--user-data-dir=/tmp/p" in cmd
    assert f"--perch-chrome-snapshot={tmp_path}" in cmd
    assert "--perch-snapshot-states=tabs,theme-dusk" in cmd
    assert "--perch-pages-dir=/repo/ui-pages/dist" in cmd
    assert not any(part.startswith("--perch-extensions-dir") for part in cmd)


def test_command_defaults_to_the_default_state_and_passes_extensions(tmp_path):
    cmd = snapshot_command(Path("/a"), Path("/r"), tmp_path, Path("/p"), [], Path("/ext"))
    assert "--perch-snapshot-states=default" in cmd and "--perch-extensions-dir=/ext" in cmd


def test_written_splits_found_and_missing(tmp_path):
    (tmp_path / "tabs.png").write_bytes(b"png")
    found, missing = written(tmp_path, ["tabs", "split"])
    assert found == [tmp_path / "tabs.png"] and missing == ["split"]


def test_cli_snapshot_needs_a_build(monkeypatch, paths, capsys):
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    assert cli.main(["snapshot"]) == 1
    assert "perch-build build" in capsys.readouterr().err


def test_cli_snapshot_runs_and_reports_missing_states(monkeypatch, paths, tmp_path, capsys):
    (paths.out("dev") / "Perch.app").mkdir(parents=True)
    out = tmp_path / "shots"

    def fake_run(cmd, check=True, **_):
        (out / "default.png").write_bytes(b"png")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "run", fake_run)
    assert cli.main(["snapshot", "--out", str(out)]) == 0
    assert cli.main(["snapshot", "--out", str(out), "--state", "default", "--state", "split"]) == 1
    assert "no picture for state split" in capsys.readouterr().err
