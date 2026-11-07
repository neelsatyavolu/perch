"""A validator for the JSON-schema subset Perch's policy catalogue uses.

Supported keywords: type, enum, items, properties, required, pattern,
minimum, maximum. These are the ones Chromium's policy schemas support too.
Objects with properties reject keys they do not list.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping

KEYWORDS = frozenset({"type", "enum", "items", "properties", "required", "pattern", "minimum", "maximum"})

TYPE_CHECKS: Mapping[str, Callable[[object], bool]] = {
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "string": lambda v: isinstance(v, str),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def schema_problems(schema: object, where: str = "schema") -> list[str]:
    """Return what is wrong with a schema itself: unknown keywords or types."""
    if not isinstance(schema, dict):
        return [f"{where} is not an object"]
    problems = [f"{where} uses unsupported keyword {key!r}" for key in sorted(set(schema) - KEYWORDS)]
    kind = schema.get("type")
    if kind not in TYPE_CHECKS:
        problems.append(f"{where} has type {kind!r}; expected one of {', '.join(TYPE_CHECKS)}")
    if kind == "array":
        if "items" not in schema:
            problems.append(f"{where} is an array without items")
        else:
            problems += schema_problems(schema["items"], f"{where}.items")
    for name, sub in schema.get("properties", {}).items():
        problems += schema_problems(sub, f"{where}.properties.{name}")
    return problems


def validate(value: object, schema: Mapping[str, object], where: str = "value") -> list[str]:
    """Return every way value fails schema; an empty list means it is valid."""
    kind = schema["type"]
    if not TYPE_CHECKS[kind](value):
        return [f"{where} should be {kind}, got {type(value).__name__}"]
    problems: list[str] = []
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{where} is {value!r}; expected one of {schema['enum']}")
    if "pattern" in schema and not re.search(schema["pattern"], value):
        problems.append(f"{where} {value!r} does not match {schema['pattern']}")
    if "minimum" in schema and value < schema["minimum"]:
        problems.append(f"{where} is below the minimum {schema['minimum']}")
    if "maximum" in schema and value > schema["maximum"]:
        problems.append(f"{where} is above the maximum {schema['maximum']}")
    if kind == "array":
        for index, item in enumerate(value):
            problems += validate(item, schema["items"], f"{where}[{index}]")
    if kind == "object":
        problems += _validate_object(value, schema, where)
    return problems


def _validate_object(value: dict, schema: Mapping[str, object], where: str) -> list[str]:
    properties = schema.get("properties", {})
    problems = [f"{where} is missing {key!r}" for key in schema.get("required", []) if key not in value]
    for key, item in value.items():
        if key in properties:
            problems += validate(item, properties[key], f"{where}.{key}")
        elif properties:
            problems.append(f"{where} has unknown key {key!r}")
    return problems
