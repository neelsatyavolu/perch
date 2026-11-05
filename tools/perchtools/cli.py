"""perch-build: check out, patch, build, package and release Perch."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from typing import Any

from .checkout import checkout
from .doctor import SystemProbe, run_checks
from .paths import REPO, Paths, load_paths
from .run import run
from .version import bump, latest_stable_mac, read_version, write_version


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def current_paths() -> Paths:
    return load_paths(os.environ)


def _doctor_ok(paths: Paths) -> bool:
    checks = run_checks(SystemProbe(), paths)
    for check in checks:
        print(f"{'ok  ' if check.ok else 'FAIL'} {check.name}: {check.detail}")
    return all(check.ok for check in checks)


def _cmd_doctor(args: argparse.Namespace) -> int:
    return 0 if _doctor_ok(current_paths()) else 1


def _cmd_checkout(args: argparse.Namespace) -> int:
    paths = current_paths()
    if not _doctor_ok(paths):
        print("Fix the failed checks above, then run perch-build checkout again.", file=sys.stderr)
        return 1
    checkout(paths, read_version(REPO / "version.json").chromium, run=run)
    return 0


def _cmd_version(args: argparse.Namespace) -> int:
    path = REPO / "version.json"
    info = read_version(path)
    if args.set_latest:
        info = type(info)(info.perch, info.build, latest_stable_mac(fetch_json))
        write_version(path, info)
    if args.bump:
        kind, *rest = args.bump
        info = bump(info, kind, rest[0] if rest else None)
        write_version(path, info)
    print(f"Perch {info.perch} (build {info.build}) on Chromium {info.chromium}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="perch-build", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    version = sub.add_parser("version", help="show or change version.json")
    version.add_argument("--set-latest", action="store_true", help="pin the latest Chromium Stable for Mac")
    version.add_argument("--bump", nargs="+", metavar=("KIND", "CHROMIUM"), help="perch | security <ver> | rebase <ver>")
    version.set_defaults(func=_cmd_version)
    sub.add_parser("doctor", help="check this Mac can build Chromium").set_defaults(func=_cmd_doctor)
    sub.add_parser("checkout", help="check out the pinned Chromium tag").set_defaults(func=_cmd_checkout)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    return args.func(args)
