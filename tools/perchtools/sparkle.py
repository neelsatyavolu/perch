"""Fetch, embed and sign Sparkle, the update framework."""

from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .run import run as default_run

# Sparkle's documented signing order for apps outside the Mac App Store sandbox.
SIGN_ORDER = (
    ("Versions/B/XPCServices/Installer.xpc", False),
    ("Versions/B/XPCServices/Downloader.xpc", True),
    ("Versions/B/Autoupdate", False),
    ("Versions/B/Updater.app", False),
    (".", False),
)


class ChecksumError(Exception):
    pass


@dataclass(frozen=True)
class SparklePin:
    version: str
    url: str
    sha256: str


def load_pin(path: Path) -> SparklePin:
    data = json.loads(path.read_text())
    return SparklePin(data["version"], data["url"], data["sha256"])


def download_file(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=120) as response, target.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def fetch_sparkle(pin: SparklePin, cache: Path, download: Callable[[str, Path], None] = download_file) -> Path:
    """Return a folder holding Sparkle.framework and bin/, downloading once per version."""
    root = cache / f"sparkle-{pin.version}"
    if (root / ".verified").exists():
        return root
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"Sparkle-{pin.version}.tar.xz"
    try:
        download(pin.url, archive)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != pin.sha256:
            raise ChecksumError(f"Sparkle {pin.version}: expected sha256 {pin.sha256}, got {digest}")
        shutil.rmtree(root, ignore_errors=True)
        with tarfile.open(archive) as tar:
            tar.extractall(root, filter="data")
        (root / ".verified").write_text(pin.sha256)
        return root
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    finally:
        archive.unlink(missing_ok=True)


def embed_sparkle(app: Path, sparkle_root: Path) -> None:
    target = app / "Contents" / "Frameworks" / "Sparkle.framework"
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(sparkle_root / "Sparkle.framework", target, symlinks=True)


def sign_sparkle(app: Path, identity: str, run=default_run) -> None:
    framework = app / "Contents" / "Frameworks" / "Sparkle.framework"
    for rel, keep_entitlements in SIGN_ORDER:
        cmd = ["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity]
        if keep_entitlements:
            cmd.append("--preserve-metadata=entitlements")
        cmd.append(framework if rel == "." else framework / rel)
        run(cmd)
