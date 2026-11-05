"""Replace the product name Chromium with Perch in user-facing strings.

Only <message> bodies in *chromium_strings*.grd and .grdp files change.
Credits ("Chromium Authors", "Chromium open source project", "Chromium
project", "Chromium OS") and <ph> placeholders keep their text. Translations
(.xtb) are left alone, so other languages fall back to English for these
strings.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

MESSAGE_RE = re.compile(r"(<message\b[^>]*>)(.*?)(</message>)", re.S)
PLACEHOLDER_RE = re.compile(r"(<ph\b.*?</ph>)", re.S)
NAME_RE = re.compile(r"\bChromium\b(?! (?:Authors|open source project|project|OS)\b)")
PATTERNS = ("*chromium_strings*.grd", "*chromium_strings*.grdp")


def _rename_body(body: str) -> str:
    parts = PLACEHOLDER_RE.split(body)
    return "".join(part if PLACEHOLDER_RE.fullmatch(part) else NAME_RE.sub("Perch", part) for part in parts)


def rename_text(text: str) -> str:
    return MESSAGE_RE.sub(lambda m: m.group(1) + _rename_body(m.group(2)) + m.group(3), text)


def rename_product_strings(src: Path) -> None:
    listed = subprocess.run(["git", "-C", str(src), "ls-files", "--", *PATTERNS], check=True, capture_output=True, text=True).stdout.split()
    for name in listed:
        path = src / name
        original = path.read_text(encoding="utf-8")
        renamed = rename_text(original)
        if renamed != original:
            path.write_text(renamed, encoding="utf-8")
