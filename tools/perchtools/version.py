"""Perch and Chromium versions, and the rules for bumping them."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Literal

CHROMIUMDASH = "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1"
CHROMIUM_RE = re.compile(r"\d+\.\d+\.\d+\.\d+")
PERCH_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")

BumpKind = Literal["rebase", "security", "perch"]


@dataclass(frozen=True)
class VersionInfo:
    perch: str
    build: int
    chromium: str


def _validate(info: VersionInfo) -> VersionInfo:
    if not PERCH_RE.fullmatch(info.perch):
        raise ValueError(f"perch version must be X.Y.Z, got {info.perch!r}")
    if not CHROMIUM_RE.fullmatch(info.chromium):
        raise ValueError(f"chromium version must be A.B.C.D, got {info.chromium!r}")
    if not isinstance(info.build, int) or info.build < 1:
        raise ValueError(f"build must be a positive integer, got {info.build!r}")
    return info


def read_version(path: Path) -> VersionInfo:
    data = json.loads(path.read_text())
    return _validate(VersionInfo(perch=data["perch"], build=data["build"], chromium=data["chromium"]))


def write_version(path: Path, info: VersionInfo) -> None:
    path.write_text(json.dumps(asdict(_validate(info)), indent=2) + "\n")


def latest_stable_mac(fetch_json: Callable[[str], Any]) -> str:
    releases = fetch_json(CHROMIUMDASH)
    if not releases:
        raise ValueError("chromiumdash returned no Stable Mac release")
    version = releases[0]["version"]
    if not CHROMIUM_RE.fullmatch(version):
        raise ValueError(f"chromiumdash returned an odd version {version!r}")
    return version


def bump(info: VersionInfo, kind: BumpKind, chromium: str | None = None) -> VersionInfo:
    major, minor, patch = (int(p) for p in PERCH_RE.fullmatch(info.perch).groups())
    if kind == "rebase":
        perch = f"{major}.{minor + 1}.0"
    elif kind in ("security", "perch"):
        perch = f"{major}.{minor}.{patch + 1}"
    else:
        raise ValueError(f"unknown bump kind {kind!r}")
    if kind in ("rebase", "security") and not chromium:
        raise ValueError(f"a {kind} bump needs the new Chromium version")
    new_chromium = chromium if kind in ("rebase", "security") else info.chromium
    return _validate(replace(info, perch=perch, build=info.build + 1, chromium=new_chromium))


def bundle_versions(info: VersionInfo) -> dict[str, str]:
    return {"CFBundleShortVersionString": info.perch, "CFBundleVersion": str(info.build)}
