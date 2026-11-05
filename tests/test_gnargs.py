from perchtools.gnargs import build, compose_args
from perchtools.paths import REPO


def _lines(text):
    return [line for line in text.splitlines() if line]


def test_dev_args():
    text = compose_args(REPO, "dev")
    assert "enable_widevine = true" in text
    assert "is_component_build = true" in text
    assert "#" not in text


def test_release_overrides_order():
    lines = _lines(compose_args(REPO, "release"))
    assert "is_official_build = true" in lines
    assert lines.count('target_cpu = "arm64"') == 1
    assert lines[0] == 'target_cpu = "arm64"'
    assert "ignore_missing_widevine_signing_cert = true" in lines


def test_later_file_replaces_in_place(tmp_path):
    args = tmp_path / "build" / "args"
    args.mkdir(parents=True)
    (args / "common.gn").write_text("a = 1\nb = 2\n")
    (args / "dev.gn").write_text("a = 3  # comment\n")
    assert compose_args(tmp_path, "dev") == "a = 3\nb = 2\n"


def test_hash_inside_quotes_kept(tmp_path):
    args = tmp_path / "build" / "args"
    args.mkdir(parents=True)
    (args / "common.gn").write_text('x = "a#b"\n')
    (args / "dev.gn").write_text("")
    assert compose_args(tmp_path, "dev") == 'x = "a#b"\n'


def test_overrides_win():
    assert "symbol_level = 2" in _lines(compose_args(REPO, "release", {"symbol_level": "2"}))


def test_build_skips_unchanged_args(paths, recorder):
    out = build(paths, "dev", run=recorder)
    args_gn = out / "args.gn"
    mtime = args_gn.stat().st_mtime_ns
    build(paths, "dev", run=recorder)
    assert args_gn.stat().st_mtime_ns == mtime
    assert [c[0] for c in recorder.calls] == ["gn", "autoninja", "gn", "autoninja"]
    assert recorder.calls[1] == ["autoninja", "-C", str(out), "chrome"]


def test_release_builds_installer(paths, recorder):
    out = build(paths, "release", run=recorder)
    assert recorder.calls[0] == ["gn", "gen", str(out)]
    assert recorder.calls[1] == ["autoninja", "-C", str(out), "chrome", "chrome/installer/mac"]
