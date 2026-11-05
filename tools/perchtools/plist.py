"""Info.plist edits made at packaging time."""

from __future__ import annotations

import plistlib
from collections.abc import Mapping
from pathlib import Path

CHECK_INTERVAL_SECONDS = 86400


def sparkle_keys(feed_url: str, public_key: str) -> dict[str, object]:
    return {
        "SUFeedURL": feed_url,
        "SUPublicEDKey": public_key,
        "SUEnableAutomaticChecks": True,
        "SUScheduledCheckInterval": CHECK_INTERVAL_SECONDS,
        "SUAutomaticallyUpdate": True,
    }


def update_plist(path: Path, values: Mapping[str, object]) -> None:
    with path.open("rb") as handle:
        data = plistlib.load(handle)
    data.update(values)
    with path.open("wb") as handle:
        plistlib.dump(data, handle)
