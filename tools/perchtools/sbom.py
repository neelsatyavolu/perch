"""The software bill of materials, checksums and the dependency check for a release.

The SBOM is one SPDX 2.3 JSON document. Perch is the root package. It
contains Chromium (with the packages Chromium's tools/licenses/licenses.py
lists), the npm packages perchd and Perch's pages ship, and Sparkle.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from . import bunlock
from .paths import Paths
from .run import run as default_run
from .version import VersionInfo, read_version

REPO_URL = "https://github.com/neelsatyavolu/perch"
SHIPPED_LOCKFILES = ("perchd/bun.lock", "ui/bun.lock", "ui-pages/bun.lock")
SPARKLE_PIN = "build/sparkle.json"
KNOWN_VULNERABILITIES = Path("docs/known-vulnerabilities.md")
PERCH_ID = "SPDXRef-Perch"
NOASSERTION = "NOASSERTION"
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class SbomError(Exception):
    pass


@dataclass(frozen=True)
class Package:
    name: str
    version: str
    purl: str
    download: str
    depends: tuple[str, ...] = ()  # purls
    checksum: tuple[str, str] | None = None  # (algorithm, hex)

    @property
    def spdx_id(self) -> str:
        return "SPDXRef-" + re.sub(r"[^A-Za-z0-9.-]", "-", self.purl.removeprefix("pkg:"))


@dataclass(frozen=True)
class Finding:
    id: str
    aliases: tuple[str, ...]
    package: str
    version: str

    def __str__(self) -> str:
        return f"{self.id} in {self.package} {self.version}"


def sbom_name(info: VersionInfo) -> str:
    return f"Perch-{info.perch}.spdx.json"


def chromium_spdx(paths: Paths, out: Path, run=default_run) -> Path:
    """Run Chromium's licenses.py for the shipped chrome target and write SPDX JSON to out."""
    info = read_version(paths.repo / "version.json")
    run([
        "python3", "tools/licenses/licenses.py", "license_file",
        "--target-os", "mac", "--gn-out-dir", "out/Release", "--gn-target", "chrome",
        "--format", "spdx", "--spdx-root", str(paths.src),
        "--spdx-link", f"https://chromium.googlesource.com/chromium/src/+/{info.chromium}",
        "--spdx-doc-name", f"Perch-{info.perch}-chromium",
        "--spdx-doc-namespace", f"{REPO_URL}/releases/v{info.perch}/chromium.spdx",
        str(out),
    ], cwd=paths.src)
    return out


def _npm_purl(name: str, version: str) -> str:
    return f"pkg:npm/{quote(name, safe='/')}@{quote(version, safe='')}"


def _github(spec: str) -> tuple[str, str]:
    repo, _, commit = spec.removeprefix("github:").partition("#")
    return repo, commit


def _purl_of(locked: bunlock.LockedPackage) -> str:
    if locked.spec.startswith("github:"):
        repo, commit = _github(locked.spec)
        return f"pkg:github/{repo}@{commit}"
    return _npm_purl(locked.name, locked.spec)


def _package(locked: bunlock.LockedPackage, purls: dict[str, str]) -> Package:
    purl = purls[locked.key]
    depends = tuple(purls[key] for key in locked.depends if key in purls)
    if locked.spec.startswith("github:"):
        repo, commit = _github(locked.spec)
        return Package(locked.name, commit, purl, f"git+https://github.com/{repo}@{commit}", depends)
    checksum = None
    algorithm, _, digest = locked.integrity.partition("-")
    if algorithm == "sha512" and digest:
        checksum = ("SHA512", base64.b64decode(digest).hex())
    tarball = f"https://registry.npmjs.org/{locked.name}/-/{locked.name.split('/')[-1]}-{locked.spec}.tgz"
    return Package(locked.name, locked.spec, purl, tarball, depends, checksum)


def lockfile_packages(lockfiles: Sequence[Path]) -> list[Package]:
    """The npm packages that ship in Perch.app, one per purl, from bun.lock files."""
    found: dict[str, Package] = {}
    for lockfile in lockfiles:
        shipped = bunlock.shipped(bunlock.load(lockfile))
        purls = {locked.key: _purl_of(locked) for locked in shipped}
        for locked in shipped:
            package = _package(locked, purls)
            earlier = found.get(package.purl)
            if earlier:
                package = Package(package.name, package.version, package.purl, package.download,
                                  tuple(dict.fromkeys(earlier.depends + package.depends)), package.checksum)
            found[package.purl] = package
    return sorted(found.values(), key=lambda p: p.purl)


def sparkle_package(pin: Path) -> Package:
    data = json.loads(pin.read_text())
    version = data["version"]
    return Package("Sparkle", version, f"pkg:github/sparkle-project/Sparkle@{version}", data["url"], (), ("SHA256", data["sha256"]))


def shipped_packages(repo: Path) -> list[Package]:
    lockfiles = [repo / name for name in SHIPPED_LOCKFILES if (repo / name).is_file()]
    return [*lockfile_packages(lockfiles), sparkle_package(repo / SPARKLE_PIN)]


def _spdx_package(package: Package) -> dict:
    entry = {
        "SPDXID": package.spdx_id,
        "name": package.name,
        "versionInfo": package.version,
        "downloadLocation": package.download,
        "filesAnalyzed": False,
        "licenseConcluded": NOASSERTION,
        "licenseDeclared": NOASSERTION,
        "copyrightText": NOASSERTION,
        "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl", "referenceLocator": package.purl}],
    }
    if package.checksum:
        entry["checksums"] = [{"algorithm": package.checksum[0], "checksumValue": package.checksum[1]}]
    return entry


def _perch_package(info: VersionInfo) -> dict:
    return {
        "SPDXID": PERCH_ID,
        "name": "Perch",
        "versionInfo": info.perch,
        "downloadLocation": f"{REPO_URL}/releases/tag/v{info.perch}",
        "filesAnalyzed": False,
        "licenseConcluded": "MIT",
        "licenseDeclared": "MIT",
        "copyrightText": NOASSERTION,
        "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl",
                          "referenceLocator": f"pkg:github/neelsatyavolu/perch@v{info.perch}"}],
    }


def _chromium_packages(doc: dict, info: VersionInfo) -> list[dict]:
    root = doc["documentDescribes"][0]
    packages = []
    for package in doc.get("packages", []):
        entry = {"downloadLocation": NOASSERTION, "filesAnalyzed": False, **package}
        if package["SPDXID"] == root:
            entry["versionInfo"] = info.chromium
            entry["downloadLocation"] = f"https://chromium.googlesource.com/chromium/src/+/{info.chromium}"
        packages.append(entry)
    return packages


def _relationship(element: str, kind: str, related: str) -> dict:
    return {"spdxElementId": element, "relationshipType": kind, "relatedSpdxElement": related}


def merge_spdx(chromium: Path, packages: Sequence[Package], info: VersionInfo, created: datetime | None = None) -> dict:
    """One SPDX 2.3 document: Perch contains Chromium's document and every shipped package."""
    doc = json.loads(chromium.read_text(encoding="utf-8"))
    chromium_root = doc["documentDescribes"][0]
    ids = {p.purl: p.spdx_id for p in packages}
    relationships = [_relationship("SPDXRef-DOCUMENT", "DESCRIBES", PERCH_ID), _relationship(PERCH_ID, "CONTAINS", chromium_root)]
    relationships += doc.get("relationships", [])
    relationships += [_relationship(PERCH_ID, "CONTAINS", p.spdx_id) for p in packages]
    relationships += [_relationship(p.spdx_id, "DEPENDS_ON", ids[purl]) for p in packages for purl in p.depends if purl in ids]
    merged = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"Perch-{info.perch}",
        "documentNamespace": f"{REPO_URL}/releases/v{info.perch}/{sbom_name(info)}",
        "creationInfo": {
            "created": (created or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "creators": ["Tool: perch-build", "Organization: Perch"],
        },
        "packages": [_perch_package(info), *_chromium_packages(doc, info), *(_spdx_package(p) for p in packages)],
        "hasExtractedLicensingInfos": doc.get("hasExtractedLicensingInfos", []),
        "relationships": relationships,
    }
    seen = [p["SPDXID"] for p in merged["packages"]]
    duplicates = sorted({spdx_id for spdx_id in seen if seen.count(spdx_id) > 1})
    if duplicates:
        raise SbomError("duplicate SPDX ids: " + ", ".join(duplicates))
    return merged


def write_sbom(paths: Paths, info: VersionInfo, out_dir: Path, run=default_run) -> Path:
    """Write out_dir/Perch-<perch>.spdx.json for the release build."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        chromium = chromium_spdx(paths, Path(scratch) / "chromium.spdx.json", run)
        merged = merge_spdx(chromium, shipped_packages(paths.repo), info)
    target = out_dir / sbom_name(info)
    target.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    return target


def checksums(files: Iterable[Path]) -> str:
    """SHA256SUMS: the lines `shasum -a 256 <name>...` prints, run where the files are."""
    lines = []
    for path in files:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        lines.append(f"{digest.hexdigest()}  {path.name}\n")
    return "".join(lines)


def parse_findings(report: dict) -> list[Finding]:
    findings: dict[tuple[str, str, str], Finding] = {}
    for result in report.get("results", []) or []:
        for entry in result.get("packages", []) or []:
            package = entry.get("package", {})
            for vuln in entry.get("vulnerabilities", []) or []:
                finding = Finding(vuln["id"], tuple(vuln.get("aliases", []) or []), package.get("name", "?"), package.get("version", "?"))
                findings[(finding.id, finding.package, finding.version)] = finding
    return sorted(findings.values(), key=lambda f: (f.id, f.package, f.version))


def vulnerability_check(sbom: Path, run=default_run) -> list[Finding]:
    """Run osv-scanner (v2) on the SBOM and return what it found."""
    result = run(["osv-scanner", "scan", "source", "--format", "json", "-L", str(sbom)], check=False, capture=True)
    if result.returncode not in (0, 1):
        raise SbomError(f"osv-scanner exited {result.returncode}: {(result.stderr or '').strip()[:500]}")
    try:
        report = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise SbomError(f"osv-scanner printed something other than JSON: {error}") from None
    return parse_findings(report)


def known_vulnerabilities(path: Path) -> set[str]:
    """Ids listed in docs/known-vulnerabilities.md. Each row needs a reason and a date."""
    if not path.is_file():
        return set()
    known: set[str] = set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells[0] in ("ID", "") or set(cells[0]) <= set("-: "):
            continue
        if len(cells) != 4 or not all(cells) or not DATE_RE.fullmatch(cells[3]):
            raise SbomError(f"{path.name} line {number} needs an id, a package, a reason and a YYYY-MM-DD date")
        known.add(cells[0].strip("`"))
    return known


def unlisted(findings: Iterable[Finding], known: set[str]) -> list[Finding]:
    return [f for f in findings if f.id not in known and not known.intersection(f.aliases)]
