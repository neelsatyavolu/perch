"""perch-build: check out, patch, build, package and release Perch."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any

from .checkout import checkout
from .doctor import SystemProbe, run_checks
from .gnargs import build as build_chromium
from .package import creds_from_env, package
from .patching import Generator, PatchFailed, apply_series, continue_series, export_series
from .paths import REPO, Paths, load_paths
from .release import REPO_SLUG, appcast, preflight, publish, published_build_from_appcast, release_notes
from .rename import rename_product_strings
from .series import read_series
from .sparkle import fetch_sparkle, load_pin
from .run import run
from .version import VersionInfo, bump, latest_stable_mac, read_version, write_version


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


GENERATORS: list[Generator] = [("product-name", rename_product_strings)]


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


def _state_file(paths: Paths):
    return paths.chromium / "perch-apply-state.json"


def _cmd_apply(args: argparse.Namespace) -> int:
    paths = current_paths()
    try:
        if args.continue_:
            continue_series(paths.src, REPO / "patches", GENERATORS, _state_file(paths))
        else:
            tag = read_version(REPO / "version.json").chromium
            apply_series(paths.src, tag, REPO / "patches", REPO / "overlay", GENERATORS, _state_file(paths))
    except PatchFailed as failure:
        print(failure, file=sys.stderr)
        return 2
    print(f"Applied Perch's changes to {paths.src} on branch perch.")
    return 0


def _cmd_export(args: argparse.Namespace) -> int:
    paths = current_paths()
    tag = read_version(REPO / "version.json").chromium
    for path in export_series(paths.src, tag, REPO / "patches"):
        print(path.relative_to(REPO))
    return 0


def _cmd_build(args: argparse.Namespace) -> int:
    out = build_chromium(current_paths(), args.config, run=run, jobs=args.jobs)
    print(f"Built {out}")
    return 0


def _cmd_package(args: argparse.Namespace) -> int:
    creds = None
    if args.mode == "release":
        try:
            creds = creds_from_env(os.environ)
        except ValueError as error:
            print(error, file=sys.stderr)
            return 1
    dmg = package(current_paths(), read_version(REPO / "version.json"), args.mode, creds, run)
    print(f"Wrote {dmg}")
    return 0


def sparkle_bin(repo: Path) -> Path:
    return fetch_sparkle(load_pin(repo / "build" / "sparkle.json"), repo / "dist" / "cache") / "bin"


def _tag_exists(tag: str) -> bool:
    return run(["gh", "release", "view", tag, "--repo", REPO_SLUG], check=False, capture=True).returncode == 0


def _published_build() -> int | None:
    result = run(["gh", "release", "download", "--repo", REPO_SLUG, "--pattern", "appcast.xml", "--output", "-"], check=False, capture=True)
    return published_build_from_appcast(result.stdout) if result.returncode == 0 else None


def _cmd_release(args: argparse.Namespace) -> int:
    paths = current_paths()
    info = read_version(REPO / "version.json")
    reasons = preflight(REPO, paths.src, info, _tag_exists, _published_build)
    for reason in reasons:
        print(f"{'warning' if args.dry_run else 'error'}: {reason}", file=sys.stderr)
    if reasons and not args.dry_run:
        return 1
    dmg = REPO / "dist" / f"Perch-{info.perch}.dmg"
    if not dmg.exists():
        print(f"error: {dmg} is missing; run perch-build package first", file=sys.stderr)
        return 1
    key_ref = os.environ.get("PERCH_SPARKLE_KEY_REF", "")
    if not key_ref:
        print("error: PERCH_SPARKLE_KEY_REF is not set; run through scripts/with-apple-creds.sh", file=sys.stderr)
        return 1
    out = REPO / "dist" / "release"
    out.mkdir(parents=True, exist_ok=True)
    feed = appcast(dmg, out, key_ref, info, sparkle_bin(REPO), run)
    notes = release_notes(info, read_series(REPO / "patches" / "series"))
    if args.dry_run:
        (out / "notes.md").write_text(notes)
        print(f"Dry run: wrote {feed} and {out / 'notes.md'}; published nothing.")
        return 0
    publish(info, dmg, feed, notes, run)
    print(f"Published Perch {info.perch}.")
    return 0


def rebase(paths: Paths, repo: Path, kind: str, version: str | None, run=run) -> VersionInfo:
    """Pin a new Chromium version, check it out and replay Perch's changes onto it."""
    current = read_version(repo / "version.json")
    target = version or latest_stable_mac(fetch_json)
    if target == current.chromium:
        raise ValueError(f"version.json already pins Chromium {target}")
    info = bump(current, kind, target)
    write_version(repo / "version.json", info)
    checkout(paths, info.chromium, run=run)
    apply_series(paths.src, info.chromium, repo / "patches", repo / "overlay", GENERATORS, _state_file(paths))
    return info


def _cmd_rebase(args: argparse.Namespace) -> int:
    try:
        info = rebase(current_paths(), REPO, "security" if args.security else "rebase", args.version, run)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except PatchFailed as failure:
        print(failure, file=sys.stderr)
        return 2
    print(f"Perch {info.perch} (build {info.build}) now applies cleanly on Chromium {info.chromium}.")
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
    apply = sub.add_parser("apply", help="apply the overlay, patches and generated changes")
    apply.add_argument("--continue", dest="continue_", action="store_true", help="resume after fixing a failed patch")
    apply.set_defaults(func=_cmd_apply)
    build = sub.add_parser("build", help="gn gen and autoninja")
    build.add_argument("--config", choices=["dev", "release"], default="dev")
    build.add_argument("--jobs", type=int, default=6, help="parallel compile jobs (default 6, low priority)")
    build.set_defaults(func=_cmd_build)
    pkg = sub.add_parser("package", help="sign, package and notarize the release build")
    pkg.add_argument("--mode", choices=["release", "adhoc"], default="release")
    pkg.set_defaults(func=_cmd_package)
    rel = sub.add_parser("release", help="check, write the appcast and publish to GitHub")
    rel.add_argument("--dry-run", action="store_true", help="write everything to dist/release and publish nothing")
    rel.set_defaults(func=_cmd_release)
    reb = sub.add_parser("rebase", help="move to a new Chromium version (latest Stable by default)")
    reb.add_argument("--security", action="store_true", help="a security point release: bump the patch version")
    reb.add_argument("version", nargs="?", help="Chromium version, e.g. 158.0.8127.30")
    reb.set_defaults(func=_cmd_rebase)
    sub.add_parser("export", help="write the perch branch's commits back to patches/").set_defaults(func=_cmd_export)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    return args.func(args)
