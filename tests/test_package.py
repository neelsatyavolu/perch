import plistlib

import pytest

from perchtools.package import AppleCreds, creds_from_env, package
from perchtools.version import VersionInfo

INFO = VersionInfo("0.1.0", 1, "158.0.8127.18")
CREDS = AppleCreds("Developer ID Application: X (T)", "KEYID123", "issuer-uuid-456", None)


@pytest.fixture
def staged_build(paths, tmp_path):
    release = paths.out("release")
    app = release / "Perch.app"
    (app / "Contents").mkdir(parents=True)
    (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "co.xanom.perch"}))
    framework = app / "Contents" / "Frameworks" / "Perch Framework.framework" / "Versions"
    (framework / "158.0.8127.18" / "Resources").mkdir(parents=True)
    (framework / "Current").symlink_to("158.0.8127.18")
    (release / "Perch Packaging").mkdir()
    (release / "Perch Packaging" / "sign_chrome.py").write_text("")
    (release / "perch_extensions" / "perch").mkdir(parents=True)
    (release / "perch_extensions" / "perch" / "manifest.json").write_text("{}")
    (release / "Perch Keys.app" / "Contents" / "MacOS").mkdir(parents=True)
    (release / "Perch Keys.app" / "Contents" / "MacOS" / "PerchKeys").write_text("bin")
    (release / "Perch Keys.app" / "Contents" / "Info.plist").write_text("plist")
    sparkle = tmp_path / "sparkle"
    (sparkle / "Sparkle.framework" / "Versions" / "B").mkdir(parents=True)
    repo = tmp_path / "repo"
    (repo / "perchd" / "skills" / "example").mkdir(parents=True)
    (repo / "perchd" / "skills" / "example" / "SKILL.md").write_text("Example skill")
    (repo / "ui" / "dist" / "assets").mkdir(parents=True)
    (repo / "ui" / "dist" / "sidebar.html").write_text("<!doctype html>")
    (repo / "ui" / "dist" / "assets" / "a.js").write_text("1")
    (repo / "ui-pages" / "dist").mkdir(parents=True)
    (repo / "ui-pages" / "dist" / "settings.html").write_text("<!doctype html>")
    (repo / "branding" / "fonts").mkdir(parents=True)
    (repo / "branding" / "fonts" / "Geist-Regular.ttf").write_bytes(b"ttf")
    (repo / "branding" / "fonts" / "OFL.txt").write_text("licence")
    (repo / "build").mkdir()
    (repo / "build" / "keys.provisionprofile").write_bytes(b"profile")
    paths = type(paths)(repo=repo, chromium=paths.chromium, src=paths.src, depot_tools=paths.depot_tools)
    return paths, sparkle


def _names(calls):
    return [c[0] if c[0] != "xcrun" else f"xcrun {c[1]} {c[2]}" for c in calls]


def test_package_release_runs_steps_in_order(staged_build, recorder):
    paths, sparkle = staged_build
    dmg = package(paths, INFO, "release", CREDS, run=recorder, sparkle_root=sparkle, public_key="PUB")
    assert dmg == paths.repo / "dist" / "Perch-0.1.0.dmg"
    assert _names(recorder.calls)[:3] == ["bun", "bun", "bun"]
    assert _names(recorder.calls)[3:] == ["codesign"] * 7 + [
        "python3", "ditto", "hdiutil", "codesign", "xcrun notarytool submit", "xcrun stapler staple",
        "codesign", "spctl", "xcrun stapler validate",
    ]
    dist = paths.repo / "dist"
    framework = dist / "stage" / "Perch.app" / "Contents" / "Frameworks" / "Perch Framework.framework" / "Versions" / "158.0.8127.18"
    perchd = framework / "Helpers" / "perchd"
    assert recorder.calls[1][:3] == ["bun", "build", "--compile"] and recorder.calls[1][-2:] == ["--outfile", str(perchd)]
    assert recorder.calls[8][:2] == ["codesign", "--force"] and recorder.calls[8][-1] == str(perchd)
    assert "--entitlements" in recorder.calls[8] and "runtime" in recorder.calls[8]
    assert (framework / "Resources" / "perch_ui" / "assets" / "a.js").read_text() == "1"
    assert (framework / "Resources" / "perch_skills" / "example" / "SKILL.md").read_text() == "Example skill"
    assert recorder.calls[10] == [
        "python3", str(dist / "stage" / "Perch Packaging" / "sign_chrome.py"),
        "--input", str(dist / "stage"), "--output", str(dist / "signed"),
        "--identity", CREDS.identity, "--disable-packaging", "--notarize", "none",
    ]
    staged = plistlib.loads((paths.repo / "dist" / "stage" / "Perch.app" / "Contents" / "Info.plist").read_bytes())
    assert staged["CFBundleVersion"] == "1" and staged["CFBundleShortVersionString"] == "0.1.0"
    assert staged["SUPublicEDKey"] == "PUB"
    assert staged["SUFeedURL"] == "https://github.com/neelsatyavolu/perch/releases/latest/download/appcast.xml"


def test_package_never_logs_secrets(staged_build, capsys):
    from conftest import Recorder
    from perchtools.run import redact

    paths, sparkle = staged_build
    logged = []

    class Logging(Recorder):
        def __call__(self, cmd, **kwargs):
            logged.append(redact(" ".join(str(c) for c in cmd), kwargs.get("secrets", ())))
            return super().__call__(cmd, **kwargs)

    package(paths, INFO, "release", CREDS, run=Logging(), sparkle_root=sparkle, public_key="PUB")
    joined = "\n".join(logged)
    assert "KEYID123" not in joined and "issuer-uuid-456" not in joined
    assert "notarytool" in joined


def test_release_requires_public_key(staged_build, recorder):
    paths, sparkle = staged_build
    with pytest.raises(ValueError, match="public_ed_key"):
        package(paths, INFO, "release", CREDS, run=recorder, sparkle_root=sparkle, public_key="")


def test_adhoc_skips_notarize_and_sparkle(staged_build, recorder):
    paths, sparkle = staged_build
    package(paths, INFO, "adhoc", None, run=recorder, sparkle_root=sparkle, public_key="")
    names = _names(recorder.calls)
    assert names == ["bun", "bun", "bun", "codesign", "codesign", "ditto", "hdiutil"]
    assert recorder.calls[4][-2:] == ["-", str(paths.repo / "dist" / "stage" / "Perch.app")]
    assert not (paths.repo / "dist" / "stage" / "Perch.app" / "Contents" / "Frameworks" / "Sparkle.framework").exists()


def test_creds_from_env_names_missing():
    with pytest.raises(ValueError) as error:
        creds_from_env({})
    for name in ["APPLE_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]:
        assert name in str(error.value)


def test_creds_from_env_reads_all(tmp_path):
    creds = creds_from_env({"APPLE_SIGNING_IDENTITY": "I", "APPLE_API_KEY": "K", "APPLE_API_ISSUER": "S", "APPLE_API_KEY_PATH": str(tmp_path / "k.p8")})
    assert creds == AppleCreds("I", "K", "S", tmp_path / "k.p8")


def test_package_copies_the_built_in_extensions_into_resources(staged_build, recorder):
    paths, sparkle = staged_build
    package(paths, INFO, "adhoc", None, run=recorder, sparkle_root=sparkle, public_key="")
    resources = paths.repo / "dist" / "stage" / "Perch.app" / "Contents" / "Frameworks" / "Perch Framework.framework" / "Versions" / "158.0.8127.18" / "Resources"
    assert (resources / "perch_extensions" / "perch" / "manifest.json").read_text() == "{}"


def test_package_refuses_without_staged_extensions(staged_build, recorder):
    import shutil
    paths, sparkle = staged_build
    shutil.rmtree(paths.out("release") / "perch_extensions")
    with pytest.raises(ValueError, match="stage-extensions"):
        package(paths, INFO, "adhoc", None, run=recorder, sparkle_root=sparkle, public_key="")


def test_package_stages_perch_pages(staged_build, recorder):
    paths, sparkle = staged_build
    package(paths, INFO, "adhoc", None, run=recorder, sparkle_root=sparkle, public_key="")
    resources = paths.repo / "dist" / "stage" / "Perch.app" / "Contents" / "Frameworks" / "Perch Framework.framework" / "Versions" / "158.0.8127.18" / "Resources"
    assert (resources / "perch_pages" / "settings.html").read_text() == "<!doctype html>"


HELPER = ("dist", "stage", "Perch.app", "Contents", "Frameworks", "Perch Framework.framework", "Versions", "158.0.8127.18",
          "Helpers", "Perch Keys.app")


def test_release_signs_the_key_helper_with_its_entitlements_before_sign_chrome(staged_build, recorder):
    paths, sparkle = staged_build
    package(paths, INFO, "release", CREDS, run=recorder, sparkle_root=sparkle, public_key="PUB")
    helper = paths.repo.joinpath(*HELPER)
    signs = [i for i, c in enumerate(recorder.calls) if c[0] == "codesign" and c[-1] == str(helper)]
    chrome = next(i for i, c in enumerate(recorder.calls) if c[0] == "python3")
    assert len(signs) == 1 and signs[0] < chrome
    call = recorder.calls[signs[0]]
    assert call[call.index("--entitlements") + 1] == str(paths.repo / "helpers" / "keyhelper" / "entitlements.plist")
    assert call[call.index("--sign") + 1] == CREDS.identity and "runtime" in call
    assert (helper / "Contents" / "embedded.provisionprofile").read_bytes() == b"profile"
    assert (helper / "Contents" / "MacOS" / "PerchKeys").read_text() == "bin"


def test_release_refuses_without_the_keys_profile(staged_build, recorder):
    paths, sparkle = staged_build
    (paths.repo / "build" / "keys.provisionprofile").unlink()
    with pytest.raises(ValueError, match="keys.provisionprofile"):
        package(paths, INFO, "release", CREDS, run=recorder, sparkle_root=sparkle, public_key="PUB")
    assert recorder.calls == []


def test_adhoc_signs_the_helper_ad_hoc_without_entitlements_or_profile(staged_build, recorder):
    paths, sparkle = staged_build
    (paths.repo / "build" / "keys.provisionprofile").unlink()
    package(paths, INFO, "adhoc", None, run=recorder, sparkle_root=sparkle, public_key="")
    helper = paths.repo.joinpath(*HELPER)
    [call] = [c for c in recorder.calls if c[0] == "codesign" and c[-1] == str(helper)]
    assert call[call.index("--sign") + 1] == "-" and "--entitlements" not in call
    assert recorder.calls.index(call) < next(i for i, c in enumerate(recorder.calls) if "--deep" in c)
    assert not (helper / "Contents" / "embedded.provisionprofile").exists()


def test_package_refuses_without_the_staged_helper(staged_build, recorder):
    import shutil
    paths, sparkle = staged_build
    shutil.rmtree(paths.out("release") / "Perch Keys.app")
    with pytest.raises(ValueError, match="Perch Keys.app"):
        package(paths, INFO, "adhoc", None, run=recorder, sparkle_root=sparkle, public_key="")


def test_stage_fonts_copies_the_ttfs_and_licence(tmp_path):
    from perchtools.package import FONTS_DIR, stage_fonts

    src = tmp_path / "repo" / FONTS_DIR
    src.mkdir(parents=True)
    (src / "Geist-Regular.ttf").write_bytes(b"ttf")
    (src / "OFL.txt").write_text("licence")
    (src / "notes.md").write_text("not copied")
    dest = stage_fonts(tmp_path / "repo", tmp_path / "out" / "perch_fonts")
    assert sorted(p.name for p in dest.iterdir()) == ["Geist-Regular.ttf", "OFL.txt"]


def test_stage_fonts_needs_fonts_and_licence(tmp_path):
    import pytest

    from perchtools.package import FONTS_DIR, stage_fonts

    (tmp_path / FONTS_DIR).mkdir(parents=True)
    (tmp_path / FONTS_DIR / "Geist-Regular.ttf").write_bytes(b"ttf")
    with pytest.raises(ValueError, match="OFL.txt"):
        stage_fonts(tmp_path, tmp_path / "out")


def test_signed_app_is_lifted_out_of_the_channel_folder(tmp_path):
    from perchtools.package import APP, _lift_signed_app

    signed = tmp_path / "signed"
    (signed / "stable" / APP / "Contents").mkdir(parents=True)
    _lift_signed_app(signed)
    assert (signed / APP / "Contents").is_dir()
    assert not (signed / "stable" / APP).exists()


def test_lifting_leaves_an_app_already_in_place(tmp_path):
    from perchtools.package import APP, _lift_signed_app

    signed = tmp_path / "signed"
    (signed / APP).mkdir(parents=True)
    _lift_signed_app(signed)
    assert (signed / APP).is_dir()
