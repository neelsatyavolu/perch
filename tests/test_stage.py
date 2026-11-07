import json
from pathlib import Path

import pytest

from perchtools.stage import Bundled, StageError, apply_edits, load_bundled, stage_extensions, write_manifest


def _entry(**over):
    base = {"name": "demo", "id": "a" * 32, "key": "S0VZ", "dist": "dist", "incognito": False}
    base.update(over)
    return base


def test_load_bundled_reads_every_field(tmp_path: Path):
    f = tmp_path / "b.json"
    f.write_text(json.dumps({"extensions": [_entry(repo="https://x/y.git", commit="c" * 40, stubs={"a.js": "s.js"})]}))
    [b] = load_bundled(f)
    assert b.name == "demo" and b.repo == "https://x/y.git" and b.commit == "c" * 40
    assert b.stubs == {"a.js": "s.js"} and b.edits == [] and b.build is None


def test_load_bundled_refuses_a_repo_without_a_pinned_commit(tmp_path: Path):
    f = tmp_path / "b.json"
    f.write_text(json.dumps({"extensions": [_entry(repo="https://x/y.git")]}))
    with pytest.raises(StageError, match="commit"):
        load_bundled(f)


def test_apply_edits_replaces_exactly_once(tmp_path: Path):
    (tmp_path / "f.html").write_text("<a>\n<b id=x>\n")
    apply_edits(tmp_path, [{"file": "f.html", "find": "<b id=x>", "replace": "<b id=x hidden>"}])
    assert (tmp_path / "f.html").read_text() == "<a>\n<b id=x hidden>\n"


@pytest.mark.parametrize("text", ["nothing here", "<b id=x><b id=x>"])
def test_apply_edits_fails_when_the_text_is_missing_or_repeated(tmp_path: Path, text: str):
    (tmp_path / "f.html").write_text(text)
    with pytest.raises(StageError, match="f.html"):
        apply_edits(tmp_path, [{"file": "f.html", "find": "<b id=x>", "replace": ""}])


def test_write_manifest_sets_key_and_incognito_and_drops_update_url(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(json.dumps({"name": "D", "update_url": "https://u", "key": "old"}))
    write_manifest(tmp_path, Bundled.from_json(_entry(source="x", incognito=False)))
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["key"] == "S0VZ" and m["incognito"] == "not_allowed" and "update_url" not in m


def test_write_manifest_leaves_incognito_alone_when_allowed(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(json.dumps({"name": "D"}))
    write_manifest(tmp_path, Bundled.from_json(_entry(source="x", incognito=True)))
    assert "incognito" not in json.loads((tmp_path / "manifest.json").read_text())


def test_stage_builds_a_local_extension_and_copies_its_dist(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "ext").mkdir(parents=True)
    calls = []

    def fake_run(cmd, cwd=None, **_):
        calls.append((list(cmd), Path(cwd)))
        dist = Path(cwd) / "dist"
        dist.mkdir(exist_ok=True)
        (dist / "manifest.json").write_text(json.dumps({"name": "Perch"}))
        (dist / "bg.js").write_text("x")

    out = tmp_path / "out"
    stage_extensions([Bundled.from_json(_entry(name="perch", source="ext", build=["bun", "run", "build"]))],
                     repo=repo, out=out, cache=tmp_path / "cache", local={}, run=fake_run)
    assert calls == [(["bun", "run", "build"], repo / "ext")]
    assert (out / "perch" / "bg.js").read_text() == "x"
    assert json.loads((out / "perch" / "manifest.json").read_text())["key"] == "S0VZ"


def test_stage_checks_out_the_pinned_commit_and_applies_stubs(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "extension" / "bundled").mkdir(parents=True)
    (repo / "extension" / "bundled" / "s.js").write_text("export function ping() {}\n")
    calls = []

    def fake_run(cmd, cwd=None, **_):
        calls.append(list(cmd))
        if cmd[:2] == ["git", "clone"]:
            dest = Path(cmd[-1])
            (dest / "lib").mkdir(parents=True)
            (dest / "lib" / "ping.js").write_text("fetch('https://analytics')\n")
            (dest / "manifest.json").write_text(json.dumps({"name": "L"}))

    out = tmp_path / "out"
    b = Bundled.from_json(_entry(name="lull", repo="https://x/l.git", commit="c" * 40, dist=".", stubs={"lib/ping.js": "s.js"}))
    stage_extensions([b], repo=repo, out=out, cache=tmp_path / "cache", local={"lull": "/src/still"}, run=fake_run)
    assert ["git", "clone", "--no-checkout", "/src/still", str(tmp_path / "cache" / "lull")] in calls
    assert ["git", "-C", str(tmp_path / "cache" / "lull"), "checkout", "--force", "--detach", "c" * 40] in calls
    assert (out / "lull" / "lib" / "ping.js").read_text() == "export function ping() {}\n"
    assert not (out / "lull" / ".git").exists()


def test_stage_leaves_out_excluded_files(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "ext" / "site").mkdir(parents=True)
    (repo / "ext" / "site" / "index.html").write_text("x")
    (repo / "ext" / "manifest.json").write_text("{}")
    b = Bundled.from_json(_entry(name="e", source="ext", dist=".", exclude=["site"]))
    stage_extensions([b], repo=repo, out=tmp_path / "out", cache=tmp_path / "c", local={}, run=lambda *a, **k: None)
    assert not (tmp_path / "out" / "e" / "site").exists()
