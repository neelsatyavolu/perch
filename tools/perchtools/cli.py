"""perch-build: check out, patch, build, package and release Perch."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from typing import Any

from .paths import REPO
from .version import bump, latest_stable_mac, read_version, write_version


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    return args.func(args)
