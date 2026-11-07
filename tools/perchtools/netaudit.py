"""Which hosts an idle Perch contacts, checked against the allowed connections (spec 5.1).

`perch-build netaudit` runs the browser headless on a fresh profile with a net log, waits, stops it,
and lists every host it reached with the allowed connection that covers it. Anything else fails
the audit. Loopback is Perch talking to its own agent and is never counted.
"""

from __future__ import annotations

import json
import re
import shutil
import signal
import subprocess
import tempfile
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}
# Certificate revocation and issuer fetches: part of verifying a TLS connection to some other host,
# and named by that host's certificate, so they are reported but never a violation.
CERT_FETCH = re.compile(r"(\.crl|\.crt|\.cer|\.p7c|/ocsp)(\b|$)", re.IGNORECASE)
CERT_CHECKS = "certificate checks"
_HOST_FIELD = re.compile(r"^(?:[a-z]+://)?(\[[^\]]+\]|[^:/]+)")


@dataclass(frozen=True)
class AllowedHosts:
    """Allowed-connection id → host patterns. `*.x` matches subdomains of x, not x itself."""

    rules: Mapping[str, tuple[str, ...]]

    @staticmethod
    def load(path: Path) -> AllowedHosts:
        raw = json.loads(path.read_text())["connections"]
        return AllowedHosts({cid: tuple(hosts) for cid, hosts in raw.items()})

    def covering(self, host: str) -> str | None:
        for cid, patterns in self.rules.items():
            if any(_matches(p, host) for p in patterns):
                return cid
        return None


def _matches(pattern: str, host: str) -> bool:
    if pattern.startswith("*."):
        return host.endswith(pattern[1:])
    return host == pattern


def _load_netlog(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # A browser that was killed leaves the events list open: close it after the last full event.
        cut = text.rstrip()
        last = cut.rfind("},")
        if last == -1:
            last = cut.rfind("}")
        return json.loads(cut[: last + 1] + "]}")


def _host_of(value: str) -> str | None:
    if "://" in value:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https", "ws", "wss"}:
            return None
        return (parts.hostname or "").lower() or None
    m = _HOST_FIELD.match(value.strip().lower())
    return m.group(1) if m else None


def hosts_from_netlog(path: Path) -> dict[str, int]:
    """Counts the hosts of URL requests and host resolutions in a Chromium net log."""
    log = _load_netlog(path.read_text())
    counts: dict[str, int] = {}
    for event in log.get("events", []):
        params = event.get("params") or {}
        for key in ("url", "host"):
            value = params.get(key)
            if isinstance(value, str):
                host = _host_of(value)
                if host and host not in LOOPBACK:
                    counts[host] = counts.get(host, 0) + 1
    return counts


def cert_check_hosts(path: Path) -> set[str]:
    """Hosts reached only for certificate revocation or issuer data."""
    log = _load_netlog(path.read_text())
    cert, other = set(), set()
    for event in log.get("events", []):
        url = (event.get("params") or {}).get("url")
        if isinstance(url, str) and (host := _host_of(url)):
            (cert if CERT_FETCH.search(urlsplit(url).path) else other).add(host)
    return cert - other


def check(hosts: Mapping[str, int], allowed: AllowedHosts, switches_off: Iterable[str] = (), cert_hosts: Iterable[str] = ()) -> list[str]:
    """The violations: hosts no allowed connection covers, or covered by one that is switched off."""
    off = set(switches_off)
    certs = set(cert_hosts)
    problems = []
    for host in sorted(hosts):
        if host in certs:
            continue
        cid = allowed.covering(host)
        if cid is None:
            problems.append(f"{host}: NOT ALLOWED")
        elif cid in off:
            problems.append(f"{host}: {cid} is switched off")
    return problems


def report(hosts: Mapping[str, int], allowed: AllowedHosts, cert_hosts: Iterable[str] = ()) -> list[str]:
    certs = set(cert_hosts)
    return [f"{host:50} {hosts[host]:5}  {CERT_CHECKS if host in certs else allowed.covering(host) or 'NOT ALLOWED'}" for host in sorted(hosts)]


def all_off_local_state(ids: Iterable[str]) -> dict:
    """Every allowed connection off, and encrypted DNS off so lookups use only the system resolver."""
    return {"perch": {"connections": {cid: False for cid in ids if cid != "encrypted_dns"}}, "dns_over_https": {"mode": "off"}}


def run_browser(app: Path, minutes: float, profile: Path, extra: list[str]) -> Path:
    """Runs the browser headless with a net log for `minutes`, then stops it. Returns the log."""
    netlog = profile / "net.json"
    binary = app / "Contents" / "MacOS" / "Perch"
    proc = subprocess.Popen(
        [str(binary), "--headless=new", f"--user-data-dir={profile / 'data'}", f"--log-net-log={netlog}",
         "--net-log-capture-mode=Default", "--no-first-run", "--use-mock-keychain",
         "--perch-netaudit-fast-timers", *extra, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(minutes * 60)
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
    return netlog


def netaudit(app: Path, allowed: AllowedHosts, minutes: float, all_off: bool, extra: list[str]) -> tuple[list[str], list[str]]:
    workdir = Path(tempfile.mkdtemp(prefix="perch-netaudit-"))
    try:
        if all_off:
            data = workdir / "data"
            data.mkdir()
            (data / "Local State").write_text(json.dumps(all_off_local_state(allowed.rules)))
        netlog = run_browser(app, minutes, workdir, extra)
        hosts = hosts_from_netlog(netlog)
        certs = cert_check_hosts(netlog)
        off = allowed.rules.keys() if all_off else ()
        return report(hosts, allowed, certs), check(hosts, allowed, off, certs)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
