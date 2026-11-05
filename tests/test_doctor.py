from perchtools.doctor import run_checks

from conftest import GIB


def _failed(checks):
    return {c.name: c.detail for c in checks if not c.ok}


def test_checks_pass_on_good_machine(fake_probe_ok, paths):
    assert all(c.ok for c in run_checks(fake_probe_ok, paths))


def test_intel_fails(fake_probe_ok, paths):
    fake_probe_ok.machine_name = "x86_64"
    assert "arm64" in _failed(run_checks(fake_probe_ok, paths))


def test_clt_only_fails(fake_probe_ok, paths):
    fake_probe_ok.xcode = "/Library/Developer/CommandLineTools"
    assert "xcode" in _failed(run_checks(fake_probe_ok, paths))


def test_low_disk_fails(fake_probe_ok, paths):
    fake_probe_ok.free = 100 * GIB
    assert "120 GiB" in _failed(run_checks(fake_probe_ok, paths))["disk"]


def test_old_python_fails(fake_probe_ok, paths):
    fake_probe_ok.python = (3, 11)
    assert "python" in _failed(run_checks(fake_probe_ok, paths))


def test_missing_depot_tools_says_how(fake_probe_ok, paths):
    fake_probe_ok.present = set()
    detail = _failed(run_checks(fake_probe_ok, paths))["depot_tools"]
    assert f"git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git {paths.depot_tools}" in detail
