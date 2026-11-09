import plistlib

from perchtools.plist import sparkle_keys, update_plist


def test_sparkle_keys():
    assert sparkle_keys("https://x/appcast.xml", "PUB") == {
        "SUFeedURL": "https://x/appcast.xml",
        "SUPublicEDKey": "PUB",
        "SUEnableAutomaticChecks": True,
        "SUScheduledCheckInterval": 86400,
        "SUAutomaticallyUpdate": True,
    }


def test_update_plist_preserves_other_keys(tmp_path):
    path = tmp_path / "Info.plist"
    path.write_bytes(plistlib.dumps({"CFBundleIdentifier": "co.xanom.perch", "CFBundleVersion": "8127.18"}))
    update_plist(path, {"CFBundleVersion": "1", "SUFeedURL": "u"})
    assert plistlib.loads(path.read_bytes()) == {"CFBundleIdentifier": "co.xanom.perch", "CFBundleVersion": "1", "SUFeedURL": "u"}
