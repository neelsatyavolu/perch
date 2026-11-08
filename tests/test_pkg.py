import json
import plistlib
import xml.etree.ElementTree as ET

import pytest

from perchtools import cli
from perchtools.package import AppleCreds
from perchtools.pkg import PKG_ID, PkgError, build_pkg, component_plist, distribution_xml, installer_identity
from perchtools.version import VersionInfo

INFO = VersionInfo("0.1.0", 1, "158.0.8127.18")
CREDS = AppleCreds("Developer ID Application: X (T)", "KEYID123", "issuer-uuid-456", None)
INSTALLER = "Developer ID Installer: X (T)"


@pytest.fixture
def app(tmp_path):
    app = tmp_path / "signed" / "Perch.app"
    (app / "Contents").mkdir(parents=True)
    return app


def _names(calls):
    return [c[0] if c[0] != "xcrun" else f"xcrun {c[1]}" + (f" {c[2]}" if c[1] == "stapler" else "") for c in calls]


def test_component_plist_installs_in_place_only():
    (entry,) = plistlib.loads(component_plist("Perch.app"))
    assert entry["RootRelativeBundlePath"] == "Perch.app"
    assert entry["BundleIsRelocatable"] is False
    assert entry["BundleIsVersionChecked"] is True
    assert entry["BundleHasStrictIdentifier"] is True
    assert entry["BundleOverwriteAction"] == "upgrade"


def test_distribution_is_arm64_only_with_no_scripts():
    xml = distribution_xml(INFO)
    root = ET.fromstring(xml)
    options = root.find("options")
    assert options.get("hostArchitectures") == "arm64" and options.get("customize") == "never"
    assert root.find("volume-check/allowed-os-versions/os-version").get("min") == "27.0"
    assert len(root.findall("choice")) == 1
    ref = [r for r in root.findall("pkg-ref") if r.text]
    assert ref[0].get("id") == PKG_ID and ref[0].get("version") == "0.1.0"
    assert "<script" not in xml


def test_release_pkg_order(app, tmp_path, recorder):
    dist = tmp_path / "dist"
    out = build_pkg(app, dist, INFO, "release", INSTALLER, CREDS, run=recorder)
    assert out == dist / "Perch-0.1.0.pkg"
    assert _names(recorder.calls) == [
        "ditto", "pkgbuild", "productbuild", "productsign", "xcrun notarytool",
        "xcrun stapler staple", "pkgutil", "spctl", "xcrun stapler validate",
    ]
    ditto, pkgbuild, productbuild, productsign = recorder.calls[:4]
    root = dist / "pkg" / "root"
    assert ditto == ["ditto", str(app), str(root / "Perch.app")]
    assert pkgbuild[pkgbuild.index("--root") + 1] == str(root)
    assert pkgbuild[pkgbuild.index("--identifier") + 1] == PKG_ID
    assert pkgbuild[pkgbuild.index("--install-location") + 1] == "/Applications"
    assert pkgbuild[pkgbuild.index("--version") + 1] == "0.1.0"
    assert plistlib.loads((dist / "pkg" / "component.plist").read_bytes())[0]["BundleIsRelocatable"] is False
    assert productbuild[-1] == str(dist / "pkg" / "unsigned.pkg")
    assert productsign == ["productsign", "--sign", INSTALLER, "--timestamp", str(dist / "pkg" / "unsigned.pkg"), str(out)]
    assert recorder.calls[6][-1] == str(out) and recorder.calls[7][:4] == ["spctl", "-a", "-t", "install"]


def test_release_pkg_never_logs_secrets(app, tmp_path, capsys):
    from perchtools.run import redact

    from conftest import Recorder

    logged = []

    class Logging(Recorder):
        def __call__(self, cmd, **kwargs):
            logged.append(redact(" ".join(str(c) for c in cmd), kwargs.get("secrets", ())))
            return super().__call__(cmd, **kwargs)

    build_pkg(app, tmp_path / "dist", INFO, "release", INSTALLER, CREDS, run=Logging())
    joined = "\n".join(logged)
    assert "notarytool" in joined
    assert "KEYID123" not in joined and "issuer-uuid-456" not in joined


def test_release_refuses_without_installer_identity(app, tmp_path, recorder):
    with pytest.raises(PkgError, match="APPLE_INSTALLER_IDENTITY"):
        build_pkg(app, tmp_path / "dist", INFO, "release", None, CREDS, run=recorder)
    assert recorder.calls == []


def test_adhoc_without_identity_is_unsigned_and_named_so(app, tmp_path, recorder):
    dist = tmp_path / "dist"
    out = build_pkg(app, dist, INFO, "adhoc", None, None, run=recorder)
    assert out == dist / "Perch-0.1.0-unsigned.pkg"
    assert _names(recorder.calls) == ["ditto", "pkgbuild", "productbuild"]
    assert recorder.calls[2][-1] == str(out)


def test_adhoc_with_identity_signs_but_does_not_notarize(app, tmp_path, recorder):
    out = build_pkg(app, tmp_path / "dist", INFO, "adhoc", INSTALLER, None, run=recorder)
    assert out.name == "Perch-0.1.0.pkg"
    assert _names(recorder.calls) == ["ditto", "pkgbuild", "productbuild", "productsign"]


def test_installer_identity_env_then_local_file(tmp_path):
    assert installer_identity({}, tmp_path) is None
    (tmp_path / "perch-build.local.json").write_text(json.dumps({"installer_identity": "From File"}))
    assert installer_identity({}, tmp_path) == "From File"
    assert installer_identity({"APPLE_INSTALLER_IDENTITY": "From Env"}, tmp_path) == "From Env"


def _package_env(monkeypatch, tmp_path, paths, seen):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "version.json").write_text(json.dumps({"perch": "0.1.0", "build": 1, "chromium": "158.0.8127.18"}))
    monkeypatch.setattr(cli, "REPO", repo)
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "stage_bundled", lambda p, config: p.out(config) / "perch_extensions")
    monkeypatch.setattr(cli, "package", lambda p, info, mode, creds, run: p.repo / "dist" / "Perch-0.1.0.dmg")
    monkeypatch.setattr(cli, "build_pkg", lambda app, dist, info, mode, identity, creds, run: seen.append((app, mode, identity)) or dist / "x.pkg")
    for name in ["APPLE_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]:
        monkeypatch.setenv(name, "x")
    monkeypatch.delenv("APPLE_INSTALLER_IDENTITY", raising=False)


def test_cli_release_package_refuses_without_installer_identity(monkeypatch, tmp_path, paths, capsys):
    seen = []
    _package_env(monkeypatch, tmp_path, paths, seen)
    assert cli.main(["package", "--mode", "release"]) == 1
    assert "APPLE_INSTALLER_IDENTITY" in capsys.readouterr().err
    assert seen == []


def test_cli_release_package_builds_pkg_from_signed_app(monkeypatch, tmp_path, paths):
    seen = []
    _package_env(monkeypatch, tmp_path, paths, seen)
    monkeypatch.setenv("APPLE_INSTALLER_IDENTITY", INSTALLER)
    assert cli.main(["package", "--mode", "release"]) == 0
    assert seen == [(paths.repo / "dist" / "signed" / "Perch.app", "release", INSTALLER)]


def test_cli_adhoc_package_builds_unsigned_pkg_from_stage(monkeypatch, tmp_path, paths):
    seen = []
    _package_env(monkeypatch, tmp_path, paths, seen)
    assert cli.main(["package", "--mode", "adhoc"]) == 0
    assert seen == [(paths.repo / "dist" / "stage" / "Perch.app", "adhoc", None)]


def test_cli_no_pkg_skips_it(monkeypatch, tmp_path, paths):
    seen = []
    _package_env(monkeypatch, tmp_path, paths, seen)
    assert cli.main(["package", "--mode", "release", "--no-pkg"]) == 0
    assert seen == []
