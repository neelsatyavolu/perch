import json
import subprocess
from pathlib import Path

import pytest

from perchtools.stage import (
    Bundled, StageError, apply_edits, load_bundled, load_update_key, stage_extensions, stage_keyhelper, write_manifest,
)


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


def _keyhelper_repo(tmp_path: Path) -> Path:
    package = tmp_path / "repo" / "helpers" / "keyhelper"
    package.mkdir(parents=True)
    (package / "Info.plist").write_text("<plist/>")
    return tmp_path / "repo"


def test_stage_keyhelper_builds_for_arm64_and_assembles_the_app(tmp_path: Path):
    repo = _keyhelper_repo(tmp_path)
    package = repo / "helpers" / "keyhelper"
    calls = []

    bin_dir = package / ".build" / "out" / "Products" / "Release"
    build = ["swift", "build", "-c", "release", "--arch", "arm64", "--package-path", str(package)]

    def fake_run(cmd, **_):
        calls.append([str(c) for c in cmd])
        bin_dir.mkdir(parents=True, exist_ok=True)
        (bin_dir / "PerchKeys").write_text("bin")
        return subprocess.CompletedProcess(cmd, 0, stdout=f"{bin_dir}\n", stderr="")

    app = stage_keyhelper(repo=repo, out=tmp_path / "out", run=fake_run)
    assert calls == [build, build + ["--show-bin-path"]]
    assert app == tmp_path / "out" / "Perch Keys.app"
    assert (app / "Contents" / "Info.plist").read_text() == "<plist/>"
    assert (app / "Contents" / "MacOS" / "PerchKeys").read_text() == "bin"


def test_stage_keyhelper_fails_when_the_build_made_nothing(tmp_path: Path):
    repo = _keyhelper_repo(tmp_path)
    with pytest.raises(StageError, match="PerchKeys"):
        stage_keyhelper(repo=repo, out=tmp_path / "out",
                        run=lambda cmd, **_: subprocess.CompletedProcess(cmd, 0, stdout=str(tmp_path / "none"), stderr=""))


def _release_zip(manifest: dict) -> bytes:
    import io
    import zipfile as z

    buf = io.BytesIO()
    with z.ZipFile(buf, "w") as f:
        f.writestr("caveatly/manifest.json", json.dumps(manifest))
        f.writestr("caveatly/background.js", "// built")
    return buf.getvalue()


def test_a_release_is_pinned_by_hash_and_gets_perchs_manifest_switches(tmp_path: Path):
    import hashlib

    data = _release_zip({"name": "Caveatly", "declarative_net_request": {"rule_resources": [{"id": "easylist", "enabled": True, "path": "r.json"}]}})
    digest = hashlib.sha256(data).hexdigest()
    b = Bundled.from_json(_entry(
        release={"url": "https://github.com/x/y/releases/download/v1/caveatly.zip", "sha256": digest},
        dist="caveatly", manifest={"caveatly_embed": {"telemetry": False, "blocker": False}}, disable_rulesets=True,
    ))
    fetched = []
    [dest] = stage_extensions([b], repo=tmp_path, out=tmp_path / "out", cache=tmp_path / "cache", local={}, run=None,
                              fetch=lambda url: fetched.append(url) or data)
    m = json.loads((dest / "manifest.json").read_text())
    assert fetched == ["https://github.com/x/y/releases/download/v1/caveatly.zip"]
    assert m["caveatly_embed"] == {"telemetry": False, "blocker": False} and m["key"] == "S0VZ"
    assert m["declarative_net_request"]["rule_resources"][0]["enabled"] is False
    assert (dest / "background.js").exists()
    # A second stage reuses the verified download.
    stage_extensions([b], repo=tmp_path, out=tmp_path / "out", cache=tmp_path / "cache", local={}, run=None,
                     fetch=lambda url: pytest.fail("downloaded again"))


def test_a_release_whose_download_changed_fails_the_build(tmp_path: Path):
    b = Bundled.from_json(_entry(release={"url": "https://x/r.zip", "sha256": "0" * 64}, dist="caveatly"))
    with pytest.raises(StageError, match="sha256"):
        stage_extensions([b], repo=tmp_path, out=tmp_path / "out", cache=tmp_path / "cache", local={}, run=None,
                         fetch=lambda url: _release_zip({"name": "C"}))


def test_a_release_needs_https_and_a_hash_and_takes_no_patches():
    with pytest.raises(StageError, match="https url"):
        Bundled.from_json(_entry(release={"url": "http://x/r.zip", "sha256": "0" * 64}))
    with pytest.raises(StageError, match="stubs"):
        Bundled.from_json(_entry(release={"url": "https://x/r.zip", "sha256": "0" * 64}, stubs={"a": "b"}))
    with pytest.raises(StageError, match="exactly one"):
        Bundled.from_json(_entry(release={"url": "https://x/r.zip", "sha256": "0" * 64}, repo="https://x/y.git", commit="c" * 40))


KEY = "ZAhFSipRm7B6RuItyopWK2kiV8dUIZEvgVocRyaOyqk="


def test_staging_writes_updates_json_for_extensions_that_update(tmp_path: Path):
    import hashlib

    data = _release_zip({"name": "Caveatly", "version": "1.0"})
    updating = Bundled.from_json(_entry(
        release={"url": "https://x/r.zip", "sha256": hashlib.sha256(data).hexdigest()}, dist="caveatly",
        manifest={"caveatly_embed": {"telemetry": False}}, disable_rulesets=True,
        updates={"repo": "o/caveatly", "asset": "caveatly.zip", "root": "caveatly", "from_version": "1.0"},
    ))
    stage_extensions([updating], repo=tmp_path, out=tmp_path / "out", cache=tmp_path / "cache", local={}, run=None,
                     fetch=lambda url: data, update_key=KEY)
    config = json.loads((tmp_path / "out" / "updates.json").read_text())
    assert config == {"public_key": KEY, "extensions": [{
        "name": "demo", "repo": "o/caveatly", "asset": "caveatly.zip", "root": "caveatly", "from_version": "1.0",
        "key": "S0VZ", "incognito": False, "manifest": {"caveatly_embed": {"telemetry": False}}, "disable_rulesets": True,
    }]}


def test_updates_need_an_owner_and_name_repo_and_an_asset():
    with pytest.raises(StageError, match="owner/name"):
        Bundled.from_json(_entry(source="ext", updates={"repo": "https://github.com/o/r", "asset": "a.zip"}))
    with pytest.raises(StageError, match="owner/name"):
        Bundled.from_json(_entry(source="ext", updates={"repo": "o/r"}))


def test_the_update_key_must_be_an_ed25519_public_key(tmp_path: Path):
    f = tmp_path / "b.json"
    f.write_text(json.dumps({"update_public_key": KEY, "extensions": []}))
    assert load_update_key(f) == KEY
    f.write_text(json.dumps({"update_public_key": "S0VZ", "extensions": []}))
    with pytest.raises(StageError, match="Ed25519"):
        load_update_key(f)


def test_the_real_config_loads_and_caveatly_updates_from_signed_releases():
    repo = Path(__file__).resolve().parents[1]
    bundled = {b.name: b for b in load_bundled(repo / "build" / "bundled-extensions.json")}
    assert load_update_key(repo / "build" / "bundled-extensions.json")
    caveatly = bundled["caveatly"]
    # Caveatly's blocker runs alongside Perch's, controlled by Perch's settings; its telemetry and
    # the parts Perch already does (GPC, cookie-banner clicking) stay off.
    assert caveatly.release and not caveatly.disable_rulesets
    assert caveatly.manifest["caveatly_embed"] == {
        "telemetry": False, "hide": ["gpc", "cookieGuard"], "controller": "ocjanjehckpdbcjamffmbeemoooamjpo",
    }
    assert caveatly.updates and caveatly.updates["repo"] == "neelsatyavolu/caveatly"
