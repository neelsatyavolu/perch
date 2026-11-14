"""perch-build: check out, patch, build, package and release Perch."""

from __future__ import annotations

import argparse
import functools
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

from .checkout import checkout
from .snapshot import snapshot_command, written
from .components import ComponentsError, check_components, new_component_reasons, write_known
from .doctor import SystemProbe, run_checks
from .gnargs import build as build_chromium, google_api_key
from .package import creds_from_env, package, packaged_app, stage_fonts
from .patching import Generator, PatchFailed, apply_series, continue_series, export_series
from .paths import REPO, Paths, load_paths
from .pkg import PkgError, build_pkg, installer_identity, require_identity
from .policies import CATALOGUE, CatalogueError, policy_ids_generator, stale_files, write_generated
from .release import REPO_SLUG, appcast, preflight, publish, published_build_from_appcast, release_assets, release_notes
from .rename import rename_product_strings
from .sbom import KNOWN_VULNERABILITIES, SbomError, checksums, known_vulnerabilities, unlisted, vulnerability_check, write_sbom
from .series import read_series
from .sparkle import fetch_sparkle, load_pin
from .stage import BUNDLED_FILE, StageError, load_bundled, load_update_key, stage_extensions, stage_keyhelper
from .netaudit import AllowedHosts, netaudit
from .run import run
from .testbin import suite_command, suite_target
from .version import VersionInfo, bump, latest_stable_mac, read_version, write_version


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


GENERATORS: list[Generator] = [
    ("product-name", rename_product_strings),
    ("policy ids", policy_ids_generator(REPO / CATALOGUE)),
]


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


def _read_secret(ref: str) -> str | None:
    """A 1Password value, or None when op is missing or can't read it. Never logged."""
    try:
        result = subprocess.run(["op", "read", ref], capture_output=True, text=True, check=False, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def _cmd_build(args: argparse.Namespace) -> int:
    overrides: dict[str, str] = {}
    if args.config == "release":
        key = google_api_key(os.environ, _read_secret)
        if key:
            overrides["google_api_key"] = f'"{key}"'
        else:
            print("warning: no Safe Browsing API key; this build's Safe Browsing lists stay empty", file=sys.stderr)
    out = build_chromium(current_paths(), args.config, run=run, jobs=args.jobs, targets=args.target or (),
                         overrides=overrides)
    print(f"Built {out}")
    return 0


def _cmd_test(args: argparse.Namespace) -> int:
    out = build_chromium(current_paths(), args.config, run=run, jobs=args.jobs, targets=[suite_target(args.suite)])
    result = run(suite_command(out, args.suite, args.filter), check=False)
    return result.returncode


def _cmd_snapshot(args: argparse.Namespace) -> int:
    paths = current_paths()
    out = paths.out(args.config)
    app = out / "Perch.app"
    if not app.is_dir():
        print(f"error: {app} is missing; run perch-build build first", file=sys.stderr)
        return 1
    out_dir = Path(args.out) if args.out else paths.repo / "dist" / "snapshots"
    out_dir.mkdir(parents=True, exist_ok=True)
    staged = out / "perch_extensions"
    with tempfile.TemporaryDirectory(prefix="perch-snapshot-") as profile:
        cmd = snapshot_command(app, paths.repo, out_dir, Path(profile), args.state,
                               staged if staged.is_dir() else None)
        result = run(cmd, check=False)
    found, missing = written(out_dir, args.state)
    for path in found:
        print(path)
    for state in missing:
        print(f"error: no picture for state {state}", file=sys.stderr)
    return 1 if missing or result.returncode else 0


def stage_bundled(paths: Paths, config: str) -> Path:
    """Build the built-in extensions into out/<config>/perch_extensions and the key helper into
    out/<config>/Perch Keys.app."""
    local_file = paths.repo / "perch-build.local.json"
    local = json.loads(local_file.read_text()).get("extensions", {}) if local_file.exists() else {}
    out = paths.out(config) / "perch_extensions"
    stage_extensions(load_bundled(paths.repo / BUNDLED_FILE), repo=paths.repo, out=out,
                     cache=paths.repo / "dist" / "cache" / "extensions", local=local, run=run,
                     update_key=load_update_key(paths.repo / BUNDLED_FILE))
    stage_keyhelper(repo=paths.repo, out=paths.out(config), run=run)
    stage_fonts(paths.repo, paths.out(config) / "perch_fonts")
    return out


def _cmd_stage(args: argparse.Namespace) -> int:
    try:
        out = stage_bundled(current_paths(), args.config)
    except StageError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Staged the built-in extensions in {out} and Perch Keys.app in {out.parent}")
    return 0


def _cmd_netaudit(args: argparse.Namespace) -> int:
    paths = current_paths()
    app = Path(args.app) if args.app else paths.out(args.config) / "Perch.app"
    allowed = AllowedHosts.load(REPO / "build" / "allowed-hosts.json")
    staged = paths.out(args.config) / "perch_extensions"
    extra = [f"--perch-extensions-dir={staged}"] if not args.app and staged.is_dir() else []
    lines, problems = netaudit(app, allowed, args.minutes, args.all_off, extra)
    for line in lines:
        print(line)
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    print(f"{len(lines)} hosts, {len(problems)} not allowed")
    return 1 if problems else 0


def _cmd_policies(args: argparse.Namespace) -> int:
    try:
        if args.action == "generate":
            for path in write_generated(REPO):
                print(f"Wrote {path}")
            return 0
        stale = stale_files(REPO)
    except CatalogueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    for path in stale:
        print(f"error: {path} is out of date; run perch-build policies generate", file=sys.stderr)
    return 1 if stale else 0


def _cmd_package(args: argparse.Namespace) -> int:
    creds = None
    if args.mode == "release":
        try:
            creds = creds_from_env(os.environ)
        except ValueError as error:
            print(error, file=sys.stderr)
            return 1
    paths = current_paths()
    identity = installer_identity(os.environ, REPO)
    try:
        if not args.no_pkg:
            require_identity(identity, args.mode)
        stage_bundled(paths, "release")
    except (PkgError, StageError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    info = read_version(REPO / "version.json")
    dmg = package(paths, info, args.mode, creds, run)
    print(f"Wrote {dmg}")
    if args.no_pkg:
        return 0
    pkg = build_pkg(packaged_app(paths.repo / "dist", args.mode), paths.repo / "dist", info, args.mode, identity, creds, run)
    print(f"Wrote {pkg}{'' if identity else ' (unsigned; for testing only)'}")
    return 0


def sparkle_bin(repo: Path) -> Path:
    return fetch_sparkle(load_pin(repo / "build" / "sparkle.json"), repo / "dist" / "cache") / "bin"


def _tag_exists(tag: str) -> bool:
    return run(["gh", "release", "view", tag, "--repo", REPO_SLUG], check=False, capture=True).returncode == 0


def _published_appcast() -> str | None:
    result = run(["gh", "release", "download", "--repo", REPO_SLUG, "--pattern", "appcast.xml", "--output", "-"], check=False, capture=True)
    return result.stdout if result.returncode == 0 else None


def _published_build() -> int | None:
    xml = _published_appcast()
    return published_build_from_appcast(xml) if xml else None


def _release_preflight(paths: Paths, info: VersionInfo, sbom) -> list[str]:
    return preflight(
        REPO, paths.src, info, _tag_exists, _published_build,
        stale_policies=lambda: stale_files(REPO),
        vulnerabilities=lambda: vulnerability_check(sbom(), run),
    ) + _component_reasons(paths)


def _cmd_release(args: argparse.Namespace) -> int:
    paths = current_paths()
    info = read_version(REPO / "version.json")
    out = REPO / "dist" / "release"
    sbom = functools.cache(lambda: write_sbom(paths, info, out, run))
    reasons = _release_preflight(paths, info, sbom)
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
    out.mkdir(parents=True, exist_ok=True)
    try:
        sbom_path = sbom()
    except (SbomError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: could not write the SBOM: {error}", file=sys.stderr)
        return 1
    feed = appcast(dmg, out, key_ref, info, sparkle_bin(REPO), run, channel=args.channel, previous=_published_appcast())
    assets = release_assets(dmg, REPO / "dist" / f"Perch-{info.perch}.pkg", feed, sbom_path)
    sums = out / "SHA256SUMS"
    sums.write_text(checksums(assets))
    notes = release_notes(info, read_series(REPO / "patches" / "series"))
    if args.dry_run:
        (out / "notes.md").write_text(notes)
        print(f"Dry run: wrote {', '.join(p.name for p in [*assets, sums])} and notes.md in {out}; published nothing.")
        return 0
    publish(info, [*assets, sums], notes, run)
    print(f"Published Perch {info.perch}.")
    return 0


def _cmd_sbom(args: argparse.Namespace) -> int:
    info = read_version(REPO / "version.json")
    try:
        sbom = write_sbom(current_paths(), info, REPO / "dist" / "release", run)
        print(f"Wrote {sbom}")
        if args.no_scan:
            return 0
        known = known_vulnerabilities(REPO / KNOWN_VULNERABILITIES)
        found = vulnerability_check(sbom, run)
    except (SbomError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    new = unlisted(found, known)
    for finding in found:
        print(f"{'not listed' if finding in new else 'listed    '} {finding}")
    print(f"{len(found)} findings, {len(new)} not listed in {KNOWN_VULNERABILITIES}")
    return 1 if new else 0


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
    reasons = _component_reasons(current_paths())
    for reason in reasons:
        print(f"error: {reason}", file=sys.stderr)
    return 1 if reasons else 0


def _component_reasons(paths: Paths) -> list[str]:
    try:
        return new_component_reasons(check_components(REPO, paths.src))
    except ComponentsError as error:
        return [str(error)]


def _cmd_components(args: argparse.Namespace) -> int:
    paths = current_paths()
    try:
        if args.action == "update":
            print(f"Wrote {write_known(REPO, paths.src)}")
            return 0
        diff = check_components(REPO, paths.src)
    except ComponentsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    for name in diff.gone:
        print(f"note: {name} is listed but registration.cc no longer calls it", file=sys.stderr)
    for reason in new_component_reasons(diff):
        print(f"error: {reason}", file=sys.stderr)
    return 1 if diff.new else 0


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
    build.add_argument("--target", action="append", metavar="TARGET",
                       help="a ninja target instead of the default (chrome); perch_unittests and "
                            "perch_browser_tests are short for chrome/browser/perch:<name>; repeatable")
    build.set_defaults(func=_cmd_build)
    test = sub.add_parser("test", help="build Perch's unit or browser tests and run them")
    test.add_argument("suite", nargs="?", choices=["unit", "browser"], default="unit",
                      help="unit runs out/<config>/perch_unittests, browser runs perch_browser_tests headless")
    test.add_argument("--filter", default="*", help="gtest filter, e.g. 'Perch*'")
    test.add_argument("--config", choices=["dev", "release"], default="dev")
    test.add_argument("--jobs", type=int, default=6, help="parallel compile jobs (default 6, low priority)")
    test.set_defaults(func=_cmd_test)
    snap = sub.add_parser("snapshot", help="render the browser window off-screen to PNGs, one per state")
    snap.add_argument("--state", action="append", default=[], metavar="STATE",
                      help="default, tabs, theme-<name>, accent-<name>, hidden-chrome, split, ...; repeatable")
    snap.add_argument("--out", help="folder for the PNGs (default dist/snapshots)")
    snap.add_argument("--config", choices=["dev", "release"], default="dev")
    snap.set_defaults(func=_cmd_snapshot)
    pkg = sub.add_parser("package", help="sign, package and notarize the release build")
    pkg.add_argument("--mode", choices=["release", "adhoc"], default="release")
    pkg.add_argument("--no-pkg", action="store_true", help="write the DMG only, no .pkg installer")
    pkg.set_defaults(func=_cmd_package)
    rel = sub.add_parser("release", help="check, write the appcast and publish to GitHub")
    rel.add_argument("--dry-run", action="store_true", help="write everything to dist/release and publish nothing")
    rel.add_argument("--channel", choices=["stable", "beta"], default="stable",
                     help="beta marks the update for Macs whose UpdateChannel policy is beta")
    rel.set_defaults(func=_cmd_release)
    reb = sub.add_parser("rebase", help="move to a new Chromium version (latest Stable by default)")
    reb.add_argument("--security", action="store_true", help="a security point release: bump the patch version")
    reb.add_argument("version", nargs="?", help="Chromium version, e.g. 158.0.8127.30")
    reb.set_defaults(func=_cmd_rebase)
    sub.add_parser("export", help="write the perch branch's commits back to patches/").set_defaults(func=_cmd_export)
    audit = sub.add_parser("netaudit", help="run Perch idle and list every host it contacts")
    audit.add_argument("--minutes", type=float, default=10)
    audit.add_argument("--all-off", action="store_true", help="turn every allowed connection off and expect no hosts")
    audit.add_argument("--config", choices=["dev", "release"], default="dev")
    audit.add_argument("--app", help="a Perch.app to audit instead of out/<config>")
    audit.set_defaults(func=_cmd_netaudit)
    stage = sub.add_parser("stage-extensions", help="build the built-in extensions into out/<config>/perch_extensions")
    stage.add_argument("--config", choices=["dev", "release"], default="dev")
    stage.set_defaults(func=_cmd_stage)
    sb = sub.add_parser("sbom", help="write the release SBOM to dist/release and check it with osv-scanner")
    sb.add_argument("--no-scan", action="store_true", help="write the SBOM only")
    sb.set_defaults(func=_cmd_sbom)
    pol = sub.add_parser("policies", help="generate or check the files made from enterprise/policies.json")
    pol.add_argument("action", choices=["generate", "check"])
    pol.set_defaults(func=_cmd_policies)
    comp = sub.add_parser("components", help="check or update the list of component registrations Perch has classified")
    comp.add_argument("action", choices=["check", "update"])
    comp.set_defaults(func=_cmd_components)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    return args.func(args)
