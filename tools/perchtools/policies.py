"""Perch's policy catalogue and the Chromium policy templates made from it.

enterprise/policies.json is the single source. From it come one Chromium
policy definition YAML per policy (an overlay directory), an id for each in
policies.yaml (assigned at apply time), docs/enterprise/policies.md and an
example configuration profile.
"""

from __future__ import annotations

import json
import plistlib
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from . import yamlemit
from .schemacheck import schema_problems, validate

PolicyType = Literal["boolean", "integer", "string", "list", "dict"]

NAME_RE = re.compile(r"[A-Z][A-Za-z0-9]+")
SCHEMA_TYPES = {"boolean": "boolean", "integer": "integer", "string": "string", "list": "array", "dict": "object"}
OWNERS = "file://chrome/browser/perch/OWNERS"
POLICIES_YAML = Path("components/policy/resources/templates/policies.yaml")
ID_LINE = re.compile(r"^  (\d+): ?(.*)$")


class CatalogueError(ValueError):
    pass


@dataclass(frozen=True)
class Policy:
    name: str
    type: PolicyType
    schema: dict
    default: object
    caption: str
    desc: str
    example: object
    dynamic: bool = True


def read_catalogue(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _policy(entry: dict) -> Policy:
    name = entry.get("name", "")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise CatalogueError(f"policy name {name!r} must match [A-Z][A-Za-z0-9]+")
    try:
        policy = Policy(
            name=name, type=entry["type"], schema=entry["schema"], default=entry["default"],
            caption=entry["caption"], desc=entry["desc"], example=entry["example"], dynamic=entry.get("dynamic", True),
        )
    except KeyError as missing:
        raise CatalogueError(f"{name} is missing {missing}") from None
    problems = schema_problems(policy.schema, f"{name}.schema")
    if not problems and SCHEMA_TYPES.get(policy.type) != policy.schema["type"]:
        problems.append(f"{name} has type {policy.type} but its schema is {policy.schema['type']}")
    if not problems and policy.default is not None:
        problems += validate(policy.default, policy.schema, f"{name} default")
    if not problems:
        problems += validate(policy.example, policy.schema, f"{name} example")
    if not policy.caption.strip() or not policy.desc.strip():
        problems.append(f"{name} needs a caption and a desc")
    if problems:
        raise CatalogueError("; ".join(problems))
    return policy


def load_catalogue(path: Path) -> list[Policy]:
    """Load and check the catalogue. A null default means unset and is always allowed."""
    policies = [_policy(entry) for entry in read_catalogue(path)["policies"]]
    seen: set[str] = set()
    for policy in policies:
        if policy.name in seen:
            raise CatalogueError(f"{policy.name} is defined twice")
        seen.add(policy.name)
    return policies


def chromium_type(p: Policy) -> str:
    """The policy type Chromium's checker derives from the schema."""
    schema = p.schema
    if p.type == "boolean":
        return "main"
    if p.type == "integer":
        return "int"
    if p.type == "string":
        return "string-enum" if "enum" in schema else "string"
    if p.type == "list":
        items = schema["items"]
        if items["type"] == "object":
            return "dict"
        return "string-enum-list" if "enum" in items else "list"
    return "dict"


def _text(value: str) -> str:
    """Chromium reads captions and descriptions as message XML."""
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _items(p: Policy, kind: str) -> list[dict] | None:
    if kind == "main":
        return [{"caption": "Enabled", "value": True}, {"caption": "Disabled", "value": False}]
    if kind == "string-enum":
        return [{"caption": v, "name": v, "value": v} for v in p.schema["enum"]]
    if kind == "string-enum-list":
        return [{"caption": v, "name": v, "value": v} for v in p.schema["items"]["enum"]]
    return None


def template_yaml(p: Policy, since: int) -> str:
    """One Chromium policy definition, named <p.name>.yaml in the Perch group."""
    kind = chromium_type(p)
    definition: dict = {
        "caption": _text(p.caption),
        "desc": _text(p.desc),
        "example_value": p.example,
        "features": {"can_be_recommended": False, "dynamic_refresh": p.dynamic, "per_profile": False},
        "owners": [OWNERS],
        "schema": p.schema,
        "supported_on": [f"chrome.*:{since}-"],
        "tags": [],
        "type": kind,
    }
    if p.default is not None:
        definition["default"] = p.default
    items = _items(p, kind)
    if items:
        definition["items"] = items
    return yamlemit.dump(definition)


def group_details_yaml() -> str:
    return yamlemit.dump({
        "caption": "Perch",
        "desc": "Perch's agent, models, memory, outside agents, remote control, sync, import, built-in extensions, telemetry, audit log and updates.",
    })


def _policies_section(lines: list[str]) -> tuple[int, int]:
    """Return the index of the policies: line and the index after its last line."""
    try:
        start = next(i for i, line in enumerate(lines) if line.rstrip("\n") == "policies:")
    except StopIteration:
        raise ValueError("policies.yaml has no policies: section") from None
    end = start + 1
    while end < len(lines) and (not lines[end].strip() or lines[end].startswith((" ", "#"))):
        end += 1
    return start, end


def assign_ids(policies_yaml: str, names: Sequence[str]) -> str:
    """Give each name missing from the policies: section the next free id."""
    lines = policies_yaml.splitlines(keepends=True)
    start, end = _policies_section(lines)
    highest, last_line, present = 0, start, set()
    for index in range(start + 1, end):
        match = ID_LINE.match(lines[index].rstrip("\n"))
        if match:
            highest = max(highest, int(match.group(1)))
            present.add(match.group(2).strip("'\""))
            last_line = index
    missing = [name for name in names if name not in present]
    added = [f"  {highest + offset}: {name}\n" for offset, name in enumerate(missing, start=1)]
    if added and not lines[last_line].endswith("\n"):
        lines[last_line] += "\n"
    return "".join(lines[: last_line + 1] + added + lines[last_line + 1 :])


def policy_ids_generator(catalogue: Path) -> Callable[[Path], None]:
    """The apply step that adds Perch's policies to <src>/.../policies.yaml."""

    def generate(src: Path) -> None:
        target = src / POLICIES_YAML
        names = [p.name for p in load_catalogue(catalogue)]
        original = target.read_text(encoding="utf-8")
        updated = assign_ids(original, names)
        if updated != original:
            target.write_text(updated, encoding="utf-8")

    return generate


PROFILE_ID = "co.xanom.perch.policies"


def _profile_uuid(identifier: str, values: Mapping[str, object]) -> str:
    seed = identifier + json.dumps(values, sort_keys=True)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"https://github.com/neelsatyavolu/perch/{seed}")).upper()


def mobileconfig(policies: Sequence[Policy], values: Mapping[str, object]) -> bytes:
    """A configuration profile that forces values for co.xanom.perch."""
    by_name = {p.name: p for p in policies}
    problems: list[str] = []
    for name, value in values.items():
        if name not in by_name:
            problems.append(f"{name} is not a Perch policy")
        else:
            problems += validate(value, by_name[name].schema, name)
    if problems:
        raise ValueError("; ".join(problems))
    payload = {
        "PayloadType": "co.xanom.perch",
        "PayloadVersion": 1,
        "PayloadIdentifier": f"{PROFILE_ID}.perch",
        "PayloadUUID": _profile_uuid(f"{PROFILE_ID}.perch", values),
        "PayloadEnabled": True,
        "PayloadDisplayName": "Perch",
        **dict(values),
    }
    profile = {
        "PayloadContent": [payload],
        "PayloadDisplayName": "Perch policies",
        "PayloadDescription": "Policies for the Perch browser.",
        "PayloadIdentifier": PROFILE_ID,
        "PayloadOrganization": "Perch example",
        "PayloadRemovalDisallowed": False,
        "PayloadScope": "System",
        "PayloadType": "Configuration",
        "PayloadUUID": _profile_uuid(PROFILE_ID, values),
        "PayloadVersion": 1,
    }
    return plistlib.dumps(profile, sort_keys=True)


def _shown(value: object) -> str:
    return "unset" if value is None else f"`{json.dumps(value)}`"


def _cell(text: str) -> str:
    return text.replace("|", "\\|")


def policies_md(policies: Sequence[Policy]) -> str:
    """docs/enterprise/policies.md: a table of every Perch policy, then each in full."""
    lines = [
        "# Perch policies",
        "",
        "Generated from `enterprise/policies.json` by `perch-build policies generate`. Do not edit by hand.",
        "",
        "Set these in a configuration profile for `co.xanom.perch`, the same way you set Chrome policies.",
        "Perch enforces a value only when it comes from a profile your MDM installs.",
        "A value set with `defaults write` does not count. `enterprise/examples/perch-example.mobileconfig` is a working example.",
        "",
        "| Policy | Type | Default | What it controls |",
        "|---|---|---|---|",
    ]
    lines += [f"| [`{p.name}`](#{p.name.lower()}) | {p.type} | {_shown(p.default)} | {_cell(p.caption)} |" for p in policies]
    for p in policies:
        lines += ["", f"## {p.name}", "", p.desc, "", f"Type: {p.type}. Default: {_shown(p.default)}.", "",
                  "Example:", "", "```json", json.dumps(p.example, indent=2), "```"]
    return "\n".join(lines) + "\n"


CATALOGUE = Path("enterprise/policies.json")
OVERLAY_GROUP = Path("overlay/components/policy/resources/templates/policy_definitions/Perch")
POLICIES_DOC = Path("docs/enterprise/policies.md")
EXAMPLE_PROFILE = Path("enterprise/examples/perch-example.mobileconfig")
EXAMPLE_VALUES = {"AgentEnabled": True, "MaxPermissionMode": "guard", "RemoteControlEnabled": False}


def generated_files(repo: Path) -> dict[Path, bytes]:
    """Every file generate writes, by path relative to repo."""
    catalogue = repo / CATALOGUE
    policies = load_catalogue(catalogue)
    since = read_catalogue(catalogue)["since"]
    files = {OVERLAY_GROUP / f"{p.name}.yaml": template_yaml(p, since).encode() for p in policies}
    files[OVERLAY_GROUP / ".group.details.yaml"] = group_details_yaml().encode()
    files[POLICIES_DOC] = policies_md(policies).encode()
    files[EXAMPLE_PROFILE] = mobileconfig(policies, EXAMPLE_VALUES)
    return files


def _strays(repo: Path, expected: Mapping[Path, bytes]) -> list[Path]:
    group = repo / OVERLAY_GROUP
    if not group.is_dir():
        return []
    return sorted(p.relative_to(repo) for p in group.iterdir() if p.is_file() and p.relative_to(repo) not in expected)


def stale_files(repo: Path) -> list[Path]:
    """Generated files that are missing, out of date, or no longer generated."""
    expected = generated_files(repo)
    stale = [path for path, content in expected.items() if not (repo / path).is_file() or (repo / path).read_bytes() != content]
    return sorted(stale + _strays(repo, expected))


def write_generated(repo: Path) -> list[Path]:
    """Write every generated file, remove ones no longer generated, and return what changed."""
    expected = generated_files(repo)
    changed = stale_files(repo)
    for path in _strays(repo, expected):
        (repo / path).unlink()
    for path, content in expected.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or target.read_bytes() != content:
            target.write_bytes(content)
    return changed
