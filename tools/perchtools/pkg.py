"""Build the installer package (.pkg) that MDM tools deploy.

Chromium's own pkg path (chrome/installer/mac/signing/pipeline.py with package_as_pkg) is not used:
its postinstall script installs GoogleUpdater and registers a brand code.
"""

from __future__ import annotations

import json
import plistlib
import shutil
from collections.abc import Mapping
from pathlib import Path
from xml.sax.saxutils import escape

from .package import APP, AppleCreds, Mode
from .run import run as default_run
from .version import VersionInfo

PKG_ID = "co.xanom.perch.pkg"
INSTALLER_VAR = "APPLE_INSTALLER_IDENTITY"
INSTALLER_KEY = "installer_identity"
LOCAL_FILE = "perch-build.local.json"
MIN_MACOS = "27.0"


class PkgError(ValueError):
    pass


def installer_identity(env: Mapping[str, str], repo: Path) -> str | None:
    """The Developer ID Installer identity: APPLE_INSTALLER_IDENTITY, then installer_identity in
    perch-build.local.json, else None."""
    if env.get(INSTALLER_VAR):
        return env[INSTALLER_VAR]
    local_file = repo / LOCAL_FILE
    local = json.loads(local_file.read_text()) if local_file.exists() else {}
    return local.get(INSTALLER_KEY) or None


def require_identity(identity: str | None, mode: Mode) -> None:
    if mode == "release" and not identity:
        raise PkgError(
            f"a release .pkg must be signed with a Developer ID Installer identity; set {INSTALLER_VAR} "
            f"(scripts/with-apple-creds.sh) or \"{INSTALLER_KEY}\" in {LOCAL_FILE}. "
            "Use perch-build package --mode adhoc for an unsigned test pkg."
        )


def pkg_path(dist: Path, info: VersionInfo, signed: bool) -> Path:
    """Unsigned pkgs get their own name, so perch-build release never uploads one."""
    return dist / (f"Perch-{info.perch}.pkg" if signed else f"Perch-{info.perch}-unsigned.pkg")


def component_plist(app_name: str = APP) -> bytes:
    """Install Perch.app only in /Applications, and upgrade an existing copy in place."""
    return plistlib.dumps([{
        "RootRelativeBundlePath": app_name,
        "BundleIsRelocatable": False,
        "BundleIsVersionChecked": True,
        "BundleHasStrictIdentifier": True,
        "BundleOverwriteAction": "upgrade",
    }])


def distribution_xml(info: VersionInfo, component: str = "Perch-component.pkg") -> str:
    """One hidden choice, arm64 only, no scripts."""
    version = escape(info.perch)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Perch</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <volume-check>
        <allowed-os-versions>
            <os-version min="{MIN_MACOS}"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="{PKG_ID}"/>
    </choices-outline>
    <choice id="{PKG_ID}" visible="false" title="Perch">
        <pkg-ref id="{PKG_ID}"/>
    </choice>
    <pkg-ref id="{PKG_ID}" version="{version}" onConclusion="none">{escape(component)}</pkg-ref>
</installer-gui-script>
"""


def build_pkg(
    app: Path,
    dist: Path,
    info: VersionInfo,
    mode: Mode,
    identity: str | None,
    creds: AppleCreds | None = None,
    run=default_run,
) -> Path:
    """Build dist/Perch-<perch>.pkg from a packaged Perch.app.

    Release: productsign with the installer identity, notarize, staple and verify. Ad hoc: signed
    when an identity is given, otherwise unsigned (Perch-<perch>-unsigned.pkg); never notarized.
    """
    require_identity(identity, mode)
    if mode == "release" and creds is None:
        raise PkgError("a release .pkg needs Apple credentials to notarize")
    work = dist / "pkg"
    shutil.rmtree(work, ignore_errors=True)
    root = work / "root"
    root.mkdir(parents=True)
    run(["ditto", app, root / APP])
    plist = work / "component.plist"
    plist.write_bytes(component_plist(APP))
    components = work / "components"
    components.mkdir()
    component = components / "Perch-component.pkg"
    run(["pkgbuild", "--root", root, "--component-plist", plist, "--identifier", PKG_ID,
         "--version", info.perch, "--install-location", "/Applications", component])
    distribution = work / "distribution.xml"
    distribution.write_text(distribution_xml(info, component.name))
    out = pkg_path(dist, info, signed=identity is not None)
    unsigned = work / "unsigned.pkg" if identity else out
    run(["productbuild", "--distribution", distribution, "--package-path", components, unsigned])
    if identity:
        run(["productsign", "--sign", identity, "--timestamp", unsigned, out])
    if mode != "release":
        return out
    secrets = [creds.api_key_id, creds.api_issuer]
    run(["xcrun", "notarytool", "submit", out, "--key", creds.api_key_path or "", "--key-id", creds.api_key_id,
         "--issuer", creds.api_issuer, "--wait"], secrets=secrets)
    run(["xcrun", "stapler", "staple", out], secrets=secrets)
    run(["pkgutil", "--check-signature", out], secrets=secrets)
    run(["spctl", "-a", "-t", "install", "-vv", out], secrets=secrets)
    run(["xcrun", "stapler", "validate", out], secrets=secrets)
    return out
