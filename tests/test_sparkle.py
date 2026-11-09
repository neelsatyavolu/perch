import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from perchtools.sparkle import ChecksumError, SparklePin, embed_sparkle, fetch_sparkle, load_pin, sign_sparkle


def _tarball():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:xz") as tar:
        for name, data in {"Sparkle.framework/Versions/B/Sparkle": b"bin", "bin/generate_appcast": b"tool"}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _writer(data):
    def download(url, target):
        target.write_bytes(data)
    return download


def test_load_pin(tmp_path):
    (tmp_path / "sparkle.json").write_text(json.dumps({"version": "2.10.1", "url": "u", "sha256": "ab" * 32, "public_ed_key": "PUB"}))
    assert load_pin(tmp_path / "sparkle.json") == SparklePin("2.10.1", "u", "ab" * 32)


def test_fetch_sparkle_rejects_bad_checksum(tmp_path):
    with pytest.raises(ChecksumError):
        fetch_sparkle(SparklePin("2.10.1", "u", "00" * 32), tmp_path, _writer(b"x"))
    assert not any(tmp_path.iterdir())


def test_fetch_sparkle_extracts_and_caches(tmp_path):
    data = _tarball()
    pin = SparklePin("2.10.1", "u", hashlib.sha256(data).hexdigest())
    root = fetch_sparkle(pin, tmp_path, _writer(data))
    assert (root / "Sparkle.framework" / "Versions" / "B" / "Sparkle").read_bytes() == b"bin"
    assert (root / "bin" / "generate_appcast").exists()

    def must_not_download(url, target):
        raise AssertionError("downloaded twice")

    assert fetch_sparkle(pin, tmp_path, must_not_download) == root


def _app_with_fake_sparkle(tmp_path):
    app = tmp_path / "Perch.app"
    framework = app / "Contents" / "Frameworks" / "Sparkle.framework"
    for rel in ["Versions/B/XPCServices/Installer.xpc", "Versions/B/XPCServices/Downloader.xpc", "Versions/B/Updater.app"]:
        (framework / rel).mkdir(parents=True)
    (framework / "Versions" / "B" / "Autoupdate").write_text("")
    return app, framework


def test_embed_sparkle_copies_framework(tmp_path):
    root = tmp_path / "sparkle"
    (root / "Sparkle.framework" / "Versions" / "B").mkdir(parents=True)
    (root / "Sparkle.framework" / "Versions" / "B" / "Sparkle").write_text("bin")
    (root / "Sparkle.framework" / "Versions" / "Current").symlink_to("B")
    app = tmp_path / "Perch.app"
    (app / "Contents").mkdir(parents=True)
    embed_sparkle(app, root)
    embedded = app / "Contents" / "Frameworks" / "Sparkle.framework"
    assert (embedded / "Versions" / "Current").is_symlink()
    assert (embedded / "Versions" / "B" / "Sparkle").read_text() == "bin"


def test_sign_sparkle_order(tmp_path, recorder):
    app, framework = _app_with_fake_sparkle(tmp_path)
    sign_sparkle(app, "Developer ID Application: X (T)", run=recorder)
    assert [str(Path(c[-1]).relative_to(framework)) for c in recorder.calls] == [
        "Versions/B/XPCServices/Installer.xpc",
        "Versions/B/XPCServices/Downloader.xpc",
        "Versions/B/Autoupdate",
        "Versions/B/Updater.app",
        ".",
    ]
    assert all(c[:6] == ["codesign", "--force", "--options", "runtime", "--timestamp", "--sign"] for c in recorder.calls)
    assert "--preserve-metadata=entitlements" in recorder.calls[1]
    assert "--preserve-metadata=entitlements" not in recorder.calls[0]
