import json
from pathlib import Path

from perchtools.netaudit import AllowedHosts, all_off_local_state, cert_check_hosts, check, hosts_from_netlog

ALLOWED = AllowedHosts({
    "extension_updates": ("clients2.google.com", "clients2.googleusercontent.com"),
    "components": ("update.googleapis.com", "*.gvt1.com"),
})


def _log(tmp_path: Path, events: list[dict], truncated: bool = False) -> Path:
    path = tmp_path / "net.json"
    body = '{"constants": {},\n"events": [\n' + ",\n".join(json.dumps(e) for e in events)
    path.write_text(body + (",\n" if truncated else "\n]}\n"))
    return path


def test_counts_url_and_resolver_hosts_and_skips_loopback(tmp_path: Path):
    path = _log(tmp_path, [
        {"type": 1, "params": {"url": "https://clients2.google.com/service/update2/crx?x=1"}},
        {"type": 2, "params": {"host": "https://clients2.google.com:443"}},
        {"type": 2, "params": {"host": "redirector.gvt1.com"}},
        {"type": 1, "params": {"url": "http://127.0.0.1:5555/api/info"}},
        {"type": 1, "params": {"url": "chrome://perch-settings/"}},
        {"type": 3, "params": {}},
    ])
    assert hosts_from_netlog(path) == {"clients2.google.com": 2, "redirector.gvt1.com": 1}


def test_reads_a_log_cut_off_by_a_killed_browser(tmp_path: Path):
    path = _log(tmp_path, [{"type": 1, "params": {"url": "https://www.gstatic.com/a"}}], truncated=True)
    assert hosts_from_netlog(path) == {"www.gstatic.com": 1}


def test_a_host_no_rule_allows_is_a_violation():
    assert check({"www.gstatic.com": 3}, ALLOWED) == ["www.gstatic.com: NOT ALLOWED"]


def test_wildcards_match_subdomains_only():
    assert ALLOWED.covering("redirector.gvt1.com") == "components"
    assert ALLOWED.covering("gvt1.com") is None
    assert check({"redirector.gvt1.com": 1, "update.googleapis.com": 1}, ALLOWED) == []


def test_with_everything_off_any_request_is_a_violation():
    problems = check({"clients2.google.com": 1}, ALLOWED, switches_off=ALLOWED.rules.keys())
    assert problems == ["clients2.google.com: extension_updates is switched off"]


def test_all_off_local_state_turns_every_connection_and_encrypted_dns_off():
    assert all_off_local_state(["components", "perch_updates", "encrypted_dns"]) == {
        "perch": {"connections": {"components": False, "perch_updates": False}},
        "dns_over_https": {"mode": "off"},
    }


def test_certificate_fetches_are_reported_but_never_violations(tmp_path: Path):
    path = _log(tmp_path, [
        {"type": 1, "params": {"url": "http://crl.example-ca.net/root.crl"}},
        {"type": 1, "params": {"url": "http://www.ca.example/security/pki/certs/issuer.cer"}},
        {"type": 1, "params": {"url": "http://crl.prod.ca.example/MjAyNi0xMQ"}},
        {"type": 1, "params": {"url": "https://www.gstatic.com/x"}},
    ])
    certs = cert_check_hosts(path)
    assert certs == {"crl.example-ca.net", "www.ca.example", "crl.prod.ca.example"}
    assert check(hosts_from_netlog(path), ALLOWED, cert_hosts=certs) == ["www.gstatic.com: NOT ALLOWED"]


def test_the_repo_list_loads():
    allowed = AllowedHosts.load(Path(__file__).resolve().parents[1] / "build" / "allowed-hosts.json")
    assert {"extension_updates", "safe_browsing_lists", "components", "translation_packs", "perch_updates"} <= set(allowed.rules)
