"""Write plain data as block-style YAML in the layout Chromium's policy files use.

Keys are sorted, list items sit at their key's indent, and any string that
could be read as something other than a string is double-quoted.
"""

from __future__ import annotations

import json
import re

PLAIN = re.compile(r"[A-Za-z][A-Za-z0-9_.*/+:-]*")
RESERVED = frozenset({"true", "false", "yes", "no", "on", "off", "null", "y", "n"})


def scalar(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        plain = PLAIN.fullmatch(value) and value.lower() not in RESERVED and not value.endswith(":")
        return value if plain else json.dumps(value, ensure_ascii=False)
    raise TypeError(f"cannot write {type(value).__name__} as YAML")


def _is_block(value: object) -> bool:
    return isinstance(value, (dict, list)) and bool(value)


def _empty(value: object) -> str:
    return "{}" if isinstance(value, dict) else "[]"


def _lines(value: object, indent: int) -> list[str]:
    pad = " " * indent
    if isinstance(value, dict):
        out: list[str] = []
        for key in sorted(value):
            item = value[key]
            if _is_block(item):
                out.append(f"{pad}{scalar(key)}:")
                out += _lines(item, indent if isinstance(item, list) else indent + 2)
            else:
                out.append(f"{pad}{scalar(key)}: {_empty(item) if isinstance(item, (dict, list)) else scalar(item)}")
        return out
    out = []
    for item in value:
        if _is_block(item):
            inner = _lines(item, indent + 2)
            out.append(f"{pad}- {inner[0].lstrip()}")
            out += inner[1:]
        else:
            out.append(f"{pad}- {_empty(item) if isinstance(item, (dict, list)) else scalar(item)}")
    return out


def dump(value: dict) -> str:
    return "\n".join(_lines(value, 0)) + "\n"
