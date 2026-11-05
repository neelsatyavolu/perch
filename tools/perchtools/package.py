"""Sign, package and notarize a release build of Perch."""

from __future__ import annotations

import json
import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .paths import Paths
from .plist import sparkle_keys, update_plist
from .run import run as default_run
from .sparkle import embed_sparkle, fetch_sparkle, load_pin, sign_sparkle
from .version import VersionInfo, bundle_versions

FEED_URL = "https://github.com/neelsatyavolu/perch/releases/latest/download/appcast.xml"
APP = "Perch.app"
PACKAGING = "Perch Packaging"
CRED_VARS = ("APPLE_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH")

Mode = Literal["release", "adhoc"]


@dataclass(frozen=True)
class AppleCreds:
    identity: str
    api_key_id: str
    api_issuer: str
    api_key_path: Path | None


def creds_from_env(env: Mapping[str, str]) -> AppleCreds:
    missing = [name for name in CRED_VARS if not env.get(name)]
    if missing:
        raise ValueError(
            "missing " + ", ".join(missing) + ". Run through scripts/with-apple-creds.sh, which loads them from 1Password."
        )
    return AppleCreds(env["APPLE_SIGNING_IDENTITY"], env["APPLE_API_KEY"], env["APPLE_API_ISSUER"], Path(env["APPLE_API_KEY_PATH"]))


def public_key_from_repo(repo: Path) -> str:
    return json.loads((repo / "build" / "sparkle.json").read_text()).get("public_ed_key", "")


def _stage(paths: Paths, dist: Path) -> Path:
    release = paths.out("release")
    stage = dist / "stage"
    for folder in (stage, dist / "signed", dist / "dmg"):
        shutil.rmtree(folder, ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copytree(release / APP, stage / APP, symlinks=True)
    shutil.copytree(release / PACKAGING, stage / PACKAGING, symlinks=True)
    return stage


def _make_dmg(app: Path, dist: Path, info: VersionInfo, run) -> Path:
    folder = dist / "dmg"
    folder.mkdir(parents=True, exist_ok=True)
    run(["ditto", app, folder / APP])
    applications = folder / "Applications"
    if not applications.is_symlink():
        applications.symlink_to("/Applications")
    dmg = dist / f"Perch-{info.perch}.dmg"
    run(["hdiutil", "create", "-ov", "-volname", "Perch", "-srcfolder", folder, "-fs", "APFS", "-format", "ULFO", dmg])
    return dmg


def package(
    paths: Paths,
    info: VersionInfo,
    mode: Mode,
    creds: AppleCreds | None,
    run=default_run,
    *,
    sparkle_root: Path | None = None,
    public_key: str | None = None,
) -> Path:
    dist = paths.repo / "dist"
    stage = _stage(paths, dist)
    app = stage / APP
    if mode == "adhoc":
        update_plist(app / "Contents" / "Info.plist", bundle_versions(info))
        run(["codesign", "--force", "--deep", "--sign", "-", app])
        return _make_dmg(app, dist, info, run)

    if creds is None:
        raise ValueError("a release package needs Apple credentials")
    key = public_key_from_repo(paths.repo) if public_key is None else public_key
    if not key:
        raise ValueError("build/sparkle.json has no public_ed_key; create the Sparkle key first (docs/building.md)")
    secrets = [creds.api_key_id, creds.api_issuer]
    root = sparkle_root or fetch_sparkle(load_pin(paths.repo / "build" / "sparkle.json"), paths.repo / "dist" / "cache")
    embed_sparkle(app, root)
    sign_sparkle(app, creds.identity, run=run)
    update_plist(app / "Contents" / "Info.plist", bundle_versions(info) | sparkle_keys(FEED_URL, key))
    signed = dist / "signed"
    run(
        ["python3", stage / PACKAGING / "sign_chrome.py", "--input", stage, "--output", signed,
         "--identity", creds.identity, "--disable-packaging", "--notarize", "none"],
        secrets=secrets,
    )
    dmg = _make_dmg(signed / APP, dist, info, run)
    run(["codesign", "--force", "--timestamp", "--sign", creds.identity, dmg], secrets=secrets)
    run(
        ["xcrun", "notarytool", "submit", dmg, "--key", creds.api_key_path or "", "--key-id", creds.api_key_id,
         "--issuer", creds.api_issuer, "--wait"],
        secrets=secrets,
    )
    run(["xcrun", "stapler", "staple", dmg], secrets=secrets)
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", signed / APP], secrets=secrets)
    run(["spctl", "-a", "-t", "exec", "-vv", signed / APP], secrets=secrets)
    run(["xcrun", "stapler", "validate", dmg], secrets=secrets)
    return dmg
