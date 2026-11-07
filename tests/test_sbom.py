import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from conftest import Recorder
from perchtools import bunlock, cli
from perchtools.sbom import (
    Finding,
    Package,
    SbomError,
    checksums,
    chromium_spdx,
    known_vulnerabilities,
    lockfile_packages,
    merge_spdx,
    parse_findings,
    shipped_packages,
    sparkle_package,
    unlisted,
    vulnerability_check,
    write_sbom,
)
from perchtools.version import VersionInfo

REPO = Path(__file__).resolve().parents[1]
INFO = VersionInfo("0.4.0", 7, "158.0.8127.18")
INTEGRITY = "sha512-j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ=="

BUN_LOCK = """{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "perchd",
      "dependencies": { "a": "1.0.0", "@s/b": "github:o/b#abc1234", },
      "devDependencies": { "typescript": "5.9.3", },
    },
  },
  "packages": {
    "a": ["a@1.0.0", "", { "dependencies": { "c": "^2", "@s/d": "1" } }, "%s"],
    "@s/b": ["@s/b@github:o/b#abc1234", {}, "o-b-abc1234", "sha512-zz"],
    "c": ["c@3.0.0", "", {}, "sha512-AAAA"],
    "a/c": ["c@2.1.0", "", { "optionalDependencies": { "e": "1" } }, "sha512-AAAA"],
    "@s/d": ["@s/d@1.0.0", "", {}, "sha512-AAAA"],
    "e": ["e@1.0.0", "", {}, "sha512-AAAA"],
    "typescript": ["typescript@5.9.3", "", {}, "sha512-AAAA"],
  }
}
""" % INTEGRITY


@pytest.fixture
def lockfile(tmp_path):
    path = tmp_path / "bun.lock"
    path.write_text(BUN_LOCK)
    return path


def chromium_doc():
    """The shape tools/licenses/licenses.py's SpdxWriter writes."""
    return {
        "spdxVersion": "SPDX-2.2",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "Perch-0.4.0-chromium",
        "documentNamespace": "https://github.com/neelsatyavolu/perch/releases/v0.4.0/chromium.spdx",
        "creationInfo": {"creators": ["Tool: spdx_writer.py"]},
        "dataLicense": "CC0-1.0",
        "documentDescribes": ["SPDXRef-Package-Chromium"],
        "packages": [
            {"SPDXID": "SPDXRef-Package-Chromium", "name": "Chromium", "licenseConcluded": "LicenseRef-Chromium"},
            {"SPDXID": "SPDXRef-Package-libpng", "name": "libpng", "licenseConcluded": "LicenseRef-libpng"},
        ],
        "hasExtractedLicensingInfos": [
            {"name": "Chromium", "licenseId": "LicenseRef-Chromium", "extractedText": "BSD", "crossRefs": [{"url": "x"}]},
            {"name": "libpng", "licenseId": "LicenseRef-libpng", "extractedText": "libpng", "crossRefs": [{"url": "y"}]},
        ],
        "relationships": [
            {"spdxElementId": "SPDXRef-Package-Chromium", "relationshipType": "CONTAINS", "relatedSpdxElement": "SPDXRef-Package-libpng"},
        ],
    }


def test_strip_trailing_commas_leaves_strings_alone():
    text = '{"a": [1, 2,], "b": "x,}", "c": {"d": 1,},}'
    assert json.loads(bunlock.strip_trailing_commas(text)) == {"a": [1, 2], "b": "x,}", "c": {"d": 1}}


def test_shipped_skips_dev_dependencies_and_resolves_nested(lockfile):
    shipped = {p.key: p for p in bunlock.shipped(bunlock.load(lockfile))}
    assert set(shipped) == {"a", "@s/b", "a/c", "@s/d", "e"}
    assert shipped["a"].depends == ("a/c", "@s/d")
    assert shipped["a/c"].spec == "2.1.0" and shipped["a/c"].depends == ("e",)


def test_resolve_walks_outwards_through_scoped_keys():
    packages = {"@s/x": [], "@s/x/y": [], "y": [], "z": []}
    assert bunlock.resolve(packages, "@s/x", "y") == "@s/x/y"
    assert bunlock.resolve(packages, "@s/x/y", "z") == "z"
    assert bunlock.resolve(packages, None, "missing") is None


def test_lockfile_packages(lockfile):
    packages = {p.purl: p for p in lockfile_packages([lockfile])}
    assert set(packages) == {"pkg:npm/a@1.0.0", "pkg:github/o/b@abc1234", "pkg:npm/c@2.1.0", "pkg:npm/%40s/d@1.0.0", "pkg:npm/e@1.0.0"}
    a = packages["pkg:npm/a@1.0.0"]
    assert a.depends == ("pkg:npm/c@2.1.0", "pkg:npm/%40s/d@1.0.0")
    assert a.checksum[0] == "SHA512" and a.checksum[1].startswith("8fb5b23dd7f408") and len(a.checksum[1]) == 128
    assert a.download == "https://registry.npmjs.org/a/-/a-1.0.0.tgz"
    assert packages["pkg:npm/%40s/d@1.0.0"].download == "https://registry.npmjs.org/@s/d/-/d-1.0.0.tgz"
    assert packages["pkg:github/o/b@abc1234"].download == "git+https://github.com/o/b@abc1234"


def test_lockfile_packages_dedupes_across_lockfiles(lockfile, tmp_path):
    other = tmp_path / "other.lock"
    shutil.copy(lockfile, other)
    assert len(lockfile_packages([lockfile, other])) == 5


def test_shipped_packages_reads_the_repo():
    packages = shipped_packages(REPO)
    assert packages[-1] == sparkle_package(REPO / "build/sparkle.json")
    assert packages[-1].checksum[0] == "SHA256"
    assert not any(p.name in ("typescript", "@types/bun") for p in packages)


def test_chromium_spdx_runs_licenses_py(paths, recorder):
    out = chromium_spdx(paths, paths.chromium / "chromium.spdx.json", run=recorder)
    cmd = recorder.calls[0]
    assert cmd[:3] == ["python3", "tools/licenses/licenses.py", "license_file"]
    assert recorder.kwargs[0]["cwd"] == paths.src and cmd[-1] == str(out)
    flags = dict(zip(cmd[3::2], cmd[4::2]))
    assert flags["--target-os"] == "mac" and flags["--gn-out-dir"] == "out/Release" and flags["--gn-target"] == "chrome"
    assert flags["--format"] == "spdx" and flags["--spdx-root"] == str(paths.src)
    assert flags["--spdx-link"].startswith("https://chromium.googlesource.com/chromium/src/+/")


def _merged(tmp_path, lockfile, created=datetime(2026, 11, 7, tzinfo=timezone.utc)):
    chromium = tmp_path / "chromium.spdx.json"
    chromium.write_text(json.dumps(chromium_doc()))
    packages = [*lockfile_packages([lockfile]), sparkle_package(REPO / "build/sparkle.json")]
    return merge_spdx(chromium, packages, INFO, created), packages


def assert_spdx_23(doc):
    """The fields SPDX 2.3's JSON schema requires, and that every reference resolves.

    A structural check: the official schema is not vendored because fetching it needs the network.
    """
    for key in ("spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace", "creationInfo"):
        assert key in doc, key
    assert doc["spdxVersion"] == "SPDX-2.3" and doc["dataLicense"] == "CC0-1.0" and doc["SPDXID"] == "SPDXRef-DOCUMENT"
    assert doc["creationInfo"]["creators"] and doc["creationInfo"]["created"].endswith("Z")
    ids = [p["SPDXID"] for p in doc["packages"]]
    assert len(ids) == len(set(ids))
    for package in doc["packages"]:
        assert {"SPDXID", "name", "downloadLocation"} <= set(package), package
        assert package["SPDXID"].startswith("SPDXRef-") and package["filesAnalyzed"] is False
    licences = {info["licenseId"] for info in doc["hasExtractedLicensingInfos"]}
    for package in doc["packages"]:
        concluded = package.get("licenseConcluded", "NOASSERTION")
        assert concluded in licences or not concluded.startswith("LicenseRef-"), concluded
    known = set(ids) | {"SPDXRef-DOCUMENT"}
    for rel in doc["relationships"]:
        assert rel["spdxElementId"] in known and rel["relatedSpdxElement"] in known, rel


def test_merge_spdx_is_one_valid_document(tmp_path, lockfile):
    doc, packages = _merged(tmp_path, lockfile)
    assert_spdx_23(doc)
    assert doc["creationInfo"]["created"] == "2026-11-07T00:00:00Z"
    assert doc["name"] == "Perch-0.4.0"
    assert doc["documentNamespace"] == "https://github.com/neelsatyavolu/perch/releases/v0.4.0/Perch-0.4.0.spdx.json"


def test_merge_spdx_puts_perch_at_the_root(tmp_path, lockfile):
    doc, packages = _merged(tmp_path, lockfile)
    rels = {(r["spdxElementId"], r["relationshipType"], r["relatedSpdxElement"]) for r in doc["relationships"]}
    assert ("SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Perch") in rels
    assert ("SPDXRef-Perch", "CONTAINS", "SPDXRef-Package-Chromium") in rels
    for package in packages:
        assert ("SPDXRef-Perch", "CONTAINS", package.spdx_id) in rels
    a = next(p for p in packages if p.name == "a")
    c = next(p for p in packages if p.name == "c")
    assert (a.spdx_id, "DEPENDS_ON", c.spdx_id) in rels
    assert any(p["name"] == "Sparkle" and p["versionInfo"] == "2.10.1" for p in doc["packages"])


def test_merge_spdx_carries_chromium_packages(tmp_path, lockfile):
    doc, _ = _merged(tmp_path, lockfile)
    by_id = {p["SPDXID"]: p for p in doc["packages"]}
    assert by_id["SPDXRef-Package-libpng"]["licenseConcluded"] == "LicenseRef-libpng"
    assert by_id["SPDXRef-Package-Chromium"]["versionInfo"] == "158.0.8127.18"
    assert ("SPDXRef-Package-Chromium", "CONTAINS", "SPDXRef-Package-libpng") in {
        (r["spdxElementId"], r["relationshipType"], r["relatedSpdxElement"]) for r in doc["relationships"]
    }
    assert len(doc["hasExtractedLicensingInfos"]) == 2


def test_merge_spdx_refuses_duplicate_ids(tmp_path):
    chromium = tmp_path / "chromium.spdx.json"
    chromium.write_text(json.dumps(chromium_doc()))
    twice = [Package("x", "1", "pkg:npm/x@1", "NOASSERTION")] * 2
    with pytest.raises(SbomError, match="duplicate"):
        merge_spdx(chromium, twice, INFO)


class LicensesRecorder(Recorder):
    """Pretends to be licenses.py: writes the SPDX file it would write."""

    def __call__(self, cmd, **kwargs):
        Path(str(cmd[-1])).write_text(json.dumps(chromium_doc()))
        return super().__call__(cmd, **kwargs)


def test_write_sbom(tmp_path, paths):
    paths = type(paths)(repo=REPO, chromium=paths.chromium, src=paths.src, depot_tools=paths.depot_tools)
    target = write_sbom(paths, INFO, tmp_path / "release", run=LicensesRecorder())
    assert target == tmp_path / "release" / "Perch-0.4.0.spdx.json"
    assert_spdx_23(json.loads(target.read_text()))


def test_checksums_match_shasum(tmp_path):
    if not shutil.which("shasum"):
        pytest.skip("shasum is not installed")
    files = [tmp_path / "Perch-0.4.0.dmg", tmp_path / "appcast.xml"]
    files[0].write_bytes(bytes(range(256)) * 5000)
    files[1].write_text("<rss/>")
    expected = subprocess.run(["shasum", "-a", "256", *[f.name for f in files]], cwd=tmp_path, capture_output=True, text=True, check=True).stdout
    assert checksums(files) == expected


OSV_REPORT = {
    "results": [{
        "source": {"path": "Perch-0.4.0.spdx.json", "type": "sbom"},
        "packages": [{
            "package": {"name": "smol-toml", "version": "1.9.1", "ecosystem": "npm"},
            "vulnerabilities": [{"id": "GHSA-aaaa-bbbb-cccc", "aliases": ["CVE-2026-1"]}],
            "groups": [{"ids": ["GHSA-aaaa-bbbb-cccc", "CVE-2026-1"]}],
        }],
    }],
}


class OsvRecorder(Recorder):
    def __init__(self, code, stdout="", stderr=""):
        super().__init__()
        self.result = (code, stdout, stderr)

    def __call__(self, cmd, **kwargs):
        super().__call__(cmd, **kwargs)
        code, stdout, stderr = self.result
        return subprocess.CompletedProcess(cmd, code, stdout=stdout, stderr=stderr)


def test_vulnerability_check_parses_findings(tmp_path):
    recorder = OsvRecorder(1, json.dumps(OSV_REPORT))
    findings = vulnerability_check(tmp_path / "Perch-0.4.0.spdx.json", run=recorder)
    assert findings == [Finding("GHSA-aaaa-bbbb-cccc", ("CVE-2026-1",), "smol-toml", "1.9.1")]
    assert recorder.calls[0] == ["osv-scanner", "scan", "source", "--format", "json", "-L", str(tmp_path / "Perch-0.4.0.spdx.json")]
    assert recorder.kwargs[0] == {"check": False, "capture": True}


def test_vulnerability_check_clean(tmp_path):
    assert vulnerability_check(tmp_path / "s.spdx.json", run=OsvRecorder(0, json.dumps({"results": []}))) == []


def test_vulnerability_check_fails_loudly(tmp_path):
    with pytest.raises(SbomError, match="exited 127"):
        vulnerability_check(tmp_path / "s.spdx.json", run=OsvRecorder(127, "", "command not found"))
    with pytest.raises(SbomError, match="JSON"):
        vulnerability_check(tmp_path / "s.spdx.json", run=OsvRecorder(1, "Scanning..."))


def test_parse_findings_dedupes():
    doubled = {"results": OSV_REPORT["results"] * 2}
    assert len(parse_findings(doubled)) == 1


def test_known_vulnerabilities_format(tmp_path):
    path = tmp_path / "known.md"
    path.write_text(
        "# Known vulnerabilities\n\nText.\n\n| ID | Package | Reason | Date |\n|---|---|---|---|\n"
        "| `GHSA-aaaa-bbbb-cccc` | smol-toml | Perch never parses untrusted TOML | 2026-11-07 |\n"
    )
    assert known_vulnerabilities(path) == {"GHSA-aaaa-bbbb-cccc"}
    path.write_text("| ID | Package | Reason | Date |\n|---|---|---|---|\n| GHSA-x | p | why | last week |\n")
    with pytest.raises(SbomError, match="line 3"):
        known_vulnerabilities(path)
    assert known_vulnerabilities(tmp_path / "missing.md") == set()


def test_committed_known_vulnerabilities_parses():
    known_vulnerabilities(REPO / "docs/known-vulnerabilities.md")


def test_unlisted_matches_ids_and_aliases():
    finding = Finding("GHSA-aaaa-bbbb-cccc", ("CVE-2026-1",), "smol-toml", "1.9.1")
    assert unlisted([finding], set()) == [finding]
    assert unlisted([finding], {"CVE-2026-1"}) == []
    assert unlisted([finding], {"GHSA-aaaa-bbbb-cccc"}) == []


def test_cli_sbom_fails_on_unlisted_finding(tmp_path, monkeypatch, paths, capsys):
    (tmp_path / "version.json").write_text(json.dumps({"perch": "0.4.0", "build": 7, "chromium": "158.0.8127.18"}))
    monkeypatch.setattr(cli, "REPO", tmp_path)
    monkeypatch.setattr(cli, "current_paths", lambda: paths)
    monkeypatch.setattr(cli, "write_sbom", lambda p, info, out, run: out / "Perch-0.4.0.spdx.json")
    finding = Finding("GHSA-aaaa-bbbb-cccc", (), "smol-toml", "1.9.1")
    monkeypatch.setattr(cli, "vulnerability_check", lambda sbom, run: [finding])
    assert cli.main(["sbom"]) == 1
    assert "not listed GHSA-aaaa-bbbb-cccc in smol-toml 1.9.1" in capsys.readouterr().out
    assert cli.main(["sbom", "--no-scan"]) == 0
