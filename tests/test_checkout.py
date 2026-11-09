from perchtools.checkout import checkout, gclient_text

VERSION = "158.0.8127.18"


def test_gclient_text_pins_pgo():
    text = gclient_text()
    assert '"checkout_pgo_profiles": True' in text
    assert 'target_os = ["mac"]' in text
    assert '"managed": False' in text
    namespace = {}
    exec(text, namespace)
    assert namespace["solutions"][0]["name"] == "src"


def test_checkout_fresh_runs_clone_then_sync(paths, recorder):
    checkout(paths, VERSION, run=recorder)
    assert (paths.chromium / ".gclient").read_text() == gclient_text()
    assert recorder.calls == [
        ["git", "clone", "--depth", "1", "--branch", VERSION, "https://chromium.googlesource.com/chromium/src.git", str(paths.src)],
        ["gclient", "sync", "--no-history", "--nohooks", "-D"],
        ["gclient", "runhooks"],
        ["tmutil", "addexclusion", str(paths.chromium)],
    ]
    assert all(kw["env"]["PATH"].startswith(str(paths.depot_tools) + ":") for kw in recorder.kwargs[:3])


def test_checkout_existing_fetches_tag(paths, recorder):
    paths.src.mkdir(parents=True)
    checkout(paths, VERSION, run=recorder)
    assert recorder.calls[:2] == [
        ["git", "-C", str(paths.src), "fetch", "--depth", "1", "origin", "tag", VERSION, "--no-tags"],
        ["git", "-C", str(paths.src), "checkout", "-f", f"tags/{VERSION}"],
    ]
    assert not any(c[:2] == ["git", "clone"] for c in recorder.calls)
