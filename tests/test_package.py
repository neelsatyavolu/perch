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
    (release / "Perch Packaging").mkdir()
    (release / "Perch Packaging" / "sign_chrome.py").write_text("")
    sparkle = tmp_path / "sparkle"
    (sparkle / "Sparkle.framework" / "Versions" / "B").mkdir(parents=True)
    repo = tmp_path / "repo"
    repo.mkdir()
    paths = type(paths)(repo=repo, chromium=paths.chromium, src=paths.src, depot_tools=paths.depot_tools)
    return paths, sparkle


def _names(calls):
    return [c[0] if c[0] != "xcrun" else f"xcrun {c[1]} {c[2]}" for c in calls]


def test_package_release_runs_steps_in_order(staged_build, recorder):
    paths, sparkle = staged_build
    dmg = package(paths, INFO, "release", CREDS, run=recorder, sparkle_root=sparkle, public_key="PUB")
    assert dmg == paths.repo / "dist" / "Perch-0.1.0.dmg"
    assert _names(recorder.calls) == ["codesign"] * 5 + [
        "python3", "ditto", "hdiutil", "codesign", "xcrun notarytool submit", "xcrun stapler staple",
        "codesign", "spctl", "xcrun stapler validate",
    ]
    dist = paths.repo / "dist"
    assert recorder.calls[5] == [
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
    assert names == ["codesign", "ditto", "hdiutil"]
    assert recorder.calls[0][-2:] == ["-", str(paths.repo / "dist" / "stage" / "Perch.app")]
    assert not (paths.repo / "dist" / "stage" / "Perch.app" / "Contents" / "Frameworks" / "Sparkle.framework").exists()


def test_creds_from_env_names_missing():
    with pytest.raises(ValueError) as error:
        creds_from_env({})
    for name in ["APPLE_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]:
        assert name in str(error.value)


def test_creds_from_env_reads_all(tmp_path):
    creds = creds_from_env({"APPLE_SIGNING_IDENTITY": "I", "APPLE_API_KEY": "K", "APPLE_API_ISSUER": "S", "APPLE_API_KEY_PATH": str(tmp_path / "k.p8")})
    assert creds == AppleCreds("I", "K", "S", tmp_path / "k.p8")
