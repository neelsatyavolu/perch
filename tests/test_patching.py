import json

import pytest

from conftest import TAG, git
from perchtools.patching import PatchFailed, apply_series, continue_series, export_series


def upper_a(src):
    (src / "a.txt").write_text((src / "a.txt").read_text().upper())


def noop(src):
    pass


def log_messages(src):
    return git(src, "log", "--format=%s", f"{TAG}..perch").split("\n")[:-1]


def _apply(src, d, generators=(("upper", upper_a),)):
    apply_series(src, TAG, d["patches"], d["overlay"], list(generators), d["state"])


def test_apply_commits_overlay_patches_generators(chromium_like, patch_dirs):
    _apply(chromium_like, patch_dirs, [("upper", upper_a), ("nothing", noop)])
    assert log_messages(chromium_like) == [
        "perch-generated: upper",
        "perch/three.patch",
        "perch/two.patch",
        "perch/one.patch",
        "perch-generated: overlay",
    ]
    assert (chromium_like / "a.txt").read_text() == "ALPHA\nONE\n"
    assert (chromium_like / "b" / "new.txt").read_text() == "from overlay\n"
    assert not (chromium_like / ".keep").exists()
    assert not patch_dirs["state"].exists()
    assert git(chromium_like, "status", "--porcelain") == ""


def test_patch_header_becomes_commit_body(chromium_like, patch_dirs):
    _apply(chromium_like, patch_dirs)
    assert "# Perch: why one exists" in git(chromium_like, "log", "--format=%B", "-1", "perch~3")


def test_apply_twice_is_identical(chromium_like, patch_dirs):
    _apply(chromium_like, patch_dirs)
    first = git(chromium_like, "rev-parse", "perch^{tree}")
    (chromium_like / "a.txt").write_text("stray edit\n")
    (chromium_like / "junk.txt").write_text("junk\n")
    (chromium_like / "out").mkdir()
    (chromium_like / "out" / "keep.bin").write_text("build output\n")
    _apply(chromium_like, patch_dirs)
    assert git(chromium_like, "rev-parse", "perch^{tree}") == first
    assert not (chromium_like / "junk.txt").exists()
    assert (chromium_like / "out" / "keep.bin").exists()


def _break_two(patch_dirs):
    two = patch_dirs["patches"] / "perch" / "two.patch"
    two.write_text(two.read_text().replace(" c2\n", " zz\n"))


def test_failing_patch_stops_and_names_it(chromium_like, patch_dirs):
    _break_two(patch_dirs)
    with pytest.raises(PatchFailed) as e:
        _apply(chromium_like, patch_dirs)
    assert e.value.patch == "perch/two.patch"
    assert e.value.rejects and all(p.suffix == ".rej" for p in e.value.rejects)
    state = json.loads(patch_dirs["state"].read_text())
    assert state == {"tag": TAG, "failed": "perch/two.patch", "remaining": ["perch/three.patch"]}
    assert log_messages(chromium_like) == ["perch/one.patch", "perch-generated: overlay"]


def test_continue_refuses_with_rej_left(chromium_like, patch_dirs):
    _break_two(patch_dirs)
    with pytest.raises(PatchFailed):
        _apply(chromium_like, patch_dirs)
    before = git(chromium_like, "rev-parse", "HEAD")
    with pytest.raises(PatchFailed):
        continue_series(chromium_like, patch_dirs["patches"], [("upper", upper_a)], patch_dirs["state"])
    assert git(chromium_like, "rev-parse", "HEAD") == before


def test_continue_resumes_after_fix(chromium_like, patch_dirs):
    _break_two(patch_dirs)
    with pytest.raises(PatchFailed) as e:
        _apply(chromium_like, patch_dirs)
    for rej in e.value.rejects:
        rej.unlink()
    (chromium_like / "b" / "c.txt").write_text("c1\nc2\ntwo fixed\n")
    continue_series(chromium_like, patch_dirs["patches"], [("upper", upper_a)], patch_dirs["state"])
    assert log_messages(chromium_like)[:3] == ["perch-generated: upper", "perch/three.patch", "perch/two.patch"]
    assert not patch_dirs["state"].exists()


def test_continue_without_state_explains(chromium_like, patch_dirs):
    with pytest.raises(FileNotFoundError, match="nothing to continue"):
        continue_series(chromium_like, patch_dirs["patches"], [], patch_dirs["state"])


def test_export_roundtrip(chromium_like, patch_dirs):
    _apply(chromium_like, patch_dirs, [])
    (chromium_like / "d.txt").write_text("delta\nmore\n")
    git(chromium_like, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qa", "--amend", "--no-edit")
    series_before = (patch_dirs["patches"] / "series").read_text()
    written = export_series(chromium_like, TAG, patch_dirs["patches"])
    assert sorted(p.name for p in written) == ["one.patch", "three.patch", "two.patch"]
    assert "+more" in (patch_dirs["patches"] / "perch" / "three.patch").read_text()
    assert (patch_dirs["patches"] / "perch" / "one.patch").read_text().startswith("# Perch: why one exists\n")
    assert (patch_dirs["patches"] / "series").read_text() == series_before
    assert not (patch_dirs["patches"] / "perch-generated: overlay").exists()


def test_exported_series_replays(chromium_like, patch_dirs):
    _apply(chromium_like, patch_dirs, [])
    tree = git(chromium_like, "rev-parse", "perch^{tree}")
    export_series(chromium_like, TAG, patch_dirs["patches"])
    _apply(chromium_like, patch_dirs, [])
    assert git(chromium_like, "rev-parse", "perch^{tree}") == tree
