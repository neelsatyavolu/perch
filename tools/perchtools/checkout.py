"""Check out a pinned Chromium tag with its dependencies."""

from __future__ import annotations

import os

from .paths import Paths
from .run import run as default_run

CHROMIUM_URL = "https://chromium.googlesource.com/chromium/src.git"

GCLIENT = '''solutions = [{"name": "src", "url": "https://chromium.googlesource.com/chromium/src.git",
  "managed": False, "custom_deps": {}, "custom_vars": {"checkout_pgo_profiles": True}}]
target_os = ["mac"]
'''


def gclient_text() -> str:
    return GCLIENT


def depot_env(paths: Paths) -> dict[str, str]:
    env = dict(os.environ)
    env["PATH"] = f"{paths.depot_tools}:{env.get('PATH', '')}"
    return env


def checkout(paths: Paths, version: str, run=default_run) -> None:
    env = depot_env(paths)
    paths.chromium.mkdir(parents=True, exist_ok=True)
    (paths.chromium / ".gclient").write_text(gclient_text())
    if paths.src.exists():
        run(["git", "-C", paths.src, "fetch", "--depth", "1", "origin", "tag", version, "--no-tags"], env=env)
        run(["git", "-C", paths.src, "checkout", "-f", f"tags/{version}"], env=env)
    else:
        run(["git", "clone", "--depth", "1", "--branch", version, CHROMIUM_URL, paths.src], env=env)
    run(["gclient", "sync", "--no-history", "--nohooks", "-D"], cwd=paths.chromium, env=env)
    run(["gclient", "runhooks"], cwd=paths.chromium, env=env)
    run(["tmutil", "addexclusion", paths.chromium])
