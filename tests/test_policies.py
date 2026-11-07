import json
import plistlib
from pathlib import Path

import pytest
import yaml

from perchtools import cli
from perchtools.policies import (
    OVERLAY_GROUP,
    POLICIES_YAML,
    CatalogueError,
    Policy,
    assign_ids,
    chromium_type,
    group_details_yaml,
    load_catalogue,
    mobileconfig,
    policies_md,
    policy_ids_generator,
    read_catalogue,
    stale_files,
    template_yaml,
    write_generated,
)
from perchtools.schemacheck import validate

REPO = Path(__file__).resolve().parents[1]
CATALOGUE = REPO / "enterprise/policies.json"
POLICIES = {p.name: p for p in load_catalogue(CATALOGUE)}
AGENT_ENABLED = POLICIES["AgentEnabled"]


def yaml_load(text):
    return yaml.safe_load(text)


def write_catalogue(tmp_path, policies):
    path = tmp_path / "policies.json"
    path.write_text(json.dumps({"version": 1, "since": 158, "policies": policies}))
    return path


def entry(**overrides):
    base = {"name": "AgentEnabled", "type": "boolean", "schema": {"type": "boolean"}, "default": True,
            "caption": "Turn the agent on or off", "desc": "When true the agent runs; when false it does not.", "example": False}
    return {**base, **overrides}


def test_catalogue_loads_every_spec_policy():
    names = {p.name for p in load_catalogue(CATALOGUE)}
    assert {"AgentEnabled", "MaxPermissionMode", "AuditLogPath", "SyncServerURL", "UpdateDelayDays"} <= names


def test_catalogue_has_the_plan_table():
    expected = {
        "AgentEnabled": ("boolean", True), "AllowedModelProviders": ("list", None), "AllowedModels": ("list", None),
        "ModelEndpoints": ("list", None), "MaxPermissionMode": ("string", "skip"), "AgentSiteRules": ("list", None),
        "MemoryEnabled": ("boolean", True), "HistoryExtractionEnabled": ("boolean", True), "MCPServerEnabled": ("boolean", True),
        "AllowedMCPClients": ("list", None), "RemoteControlEnabled": ("boolean", True), "SyncEnabled": ("boolean", True),
        "SyncServerURL": ("string", "https://api.perchbrowser.com"), "ImportEnabled": ("dict", None),
        "BuiltInExtensions": ("dict", {"backrow": True, "memorySaver": True}), "TelemetryEnabled": ("boolean", False),
        "AuditLogPath": ("string", None), "AutoUpdateEnabled": ("boolean", True), "UpdateChannel": ("string", "stable"),
        "UpdateDelayDays": ("integer", 0), "MinimumVersion": ("string", None),
    }
    assert {name: (p.type, p.default) for name, p in POLICIES.items()} == expected


def test_catalogue_rejects_duplicates(tmp_path):
    with pytest.raises(CatalogueError, match="AgentEnabled is defined twice"):
        load_catalogue(write_catalogue(tmp_path, [entry(), entry()]))


def test_catalogue_rejects_bad_name(tmp_path):
    with pytest.raises(CatalogueError, match="agent_enabled"):
        load_catalogue(write_catalogue(tmp_path, [entry(name="agent_enabled")]))


def test_catalogue_rejects_bad_default(tmp_path):
    bad = entry(name="MaxPermissionMode", type="string", schema={"type": "string", "enum": ["ask", "guard", "skip"]},
                default="loud", example="guard")
    with pytest.raises(CatalogueError, match="MaxPermissionMode default"):
        load_catalogue(write_catalogue(tmp_path, [bad]))


def test_catalogue_rejects_bad_example(tmp_path):
    bad = entry(name="UpdateDelayDays", type="integer", schema={"type": "integer", "minimum": 0, "maximum": 30}, default=0, example=31)
    with pytest.raises(CatalogueError, match="UpdateDelayDays example"):
        load_catalogue(write_catalogue(tmp_path, [bad]))


def test_catalogue_allows_null_default(tmp_path):
    ok = entry(name="AuditLogPath", type="string", schema={"type": "string", "pattern": "^(/|~/)"}, default=None, example="~/a.jsonl")
    assert load_catalogue(write_catalogue(tmp_path, [ok]))[0].default is None


def test_catalogue_rejects_type_schema_mismatch(tmp_path):
    with pytest.raises(CatalogueError, match="type list but its schema is boolean"):
        load_catalogue(write_catalogue(tmp_path, [entry(type="list")]))


def test_catalogue_rejects_unsupported_schema_keyword(tmp_path):
    with pytest.raises(CatalogueError, match="unsupported keyword 'format'"):
        load_catalogue(write_catalogue(tmp_path, [entry(schema={"type": "boolean", "format": "x"})]))


@pytest.mark.parametrize(("value", "schema", "ok"), [
    (True, {"type": "boolean"}, True),
    (1, {"type": "boolean"}, False),
    (True, {"type": "integer"}, False),
    (5, {"type": "integer", "minimum": 0, "maximum": 30}, True),
    (-1, {"type": "integer", "minimum": 0}, False),
    ("https://a.example", {"type": "string", "pattern": "^https://"}, True),
    ("http://a.example", {"type": "string", "pattern": "^https://"}, False),
    (["a", "b"], {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}}, True),
    (["c"], {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}}, False),
    ({"name": "x"}, {"type": "object", "properties": {"name": {"type": "string"}, "url": {"type": "string"}}, "required": ["url"]}, False),
    ({"nme": "x"}, {"type": "object", "properties": {"name": {"type": "string"}}}, False),
])
def test_validate_schema_subset(value, schema, ok):
    assert (validate(value, schema) == []) is ok


def test_boolean_descriptions_say_what_true_and_false_do():
    # Chromium's syntax_check_policy_template_json.py refuses boolean policies whose desc doesn't.
    for p in POLICIES.values():
        if p.type == "boolean":
            desc = p.desc.lower()
            assert any(word in desc for word in ("true", "enable", "allowed")), p.name
            assert any(word in desc for word in ("false", "disable", "not allowed", "disallowed")), p.name


def test_template_yaml_boolean():
    y = yaml_load(template_yaml(AGENT_ENABLED, 158))
    assert y["supported_on"] == ["chrome.*:158-"] and y["features"]["can_be_recommended"] is False
    assert [i["value"] for i in y["items"]] == [True, False]
    assert all("name" not in i for i in y["items"])  # Chromium refuses names on boolean items
    assert y["type"] == "main" and y["default"] is True and y["example_value"] is False
    assert y["owners"] == ["file://chrome/browser/perch/OWNERS"] and y["tags"] == []
    assert y["features"] == {"can_be_recommended": False, "dynamic_refresh": True, "per_profile": False}


def test_template_yaml_string_enum():
    y = yaml_load(template_yaml(POLICIES["MaxPermissionMode"], 158))
    assert y["type"] == "string-enum" and y["default"] == "skip"
    assert [(i["name"], i["value"]) for i in y["items"]] == [("ask", "ask"), ("guard", "guard"), ("skip", "skip")]
    assert y["schema"] == {"type": "string", "enum": ["ask", "guard", "skip"]}


@pytest.mark.parametrize(("name", "kind"), [
    ("UpdateDelayDays", "int"), ("AuditLogPath", "string"), ("AllowedModels", "list"),
    ("AllowedModelProviders", "string-enum-list"), ("ModelEndpoints", "dict"), ("ImportEnabled", "dict"),
])
def test_chromium_type_follows_the_schema(name, kind):
    assert chromium_type(POLICIES[name]) == kind


def test_template_yaml_round_trips_every_policy():
    for p in POLICIES.values():
        y = yaml_load(template_yaml(p, 158))
        assert y["schema"] == p.schema and y["example_value"] == p.example, p.name
        assert ("default" in y) is (p.default is not None) and y.get("default") == p.default, p.name


def test_template_yaml_escapes_markup():
    p = Policy("SomePolicy", "string", {"type": "string"}, None, "A <b> & c", "keychain:<service>/<account>", "x")
    y = yaml_load(template_yaml(p, 158))
    assert y["caption"] == "A &lt;b&gt; &amp; c" and y["desc"] == "keychain:&lt;service&gt;/&lt;account&gt;"


def test_group_details_yaml():
    assert yaml_load(group_details_yaml())["caption"] == "Perch"


def test_assign_ids_appends_after_highest():
    out = assign_ids("policies:\n  1: HomepageLocation\n  1496: Last\natomic_groups:\n  1: Group\n", ["AgentEnabled", "MemoryEnabled"])
    assert "  1497: AgentEnabled\n  1498: MemoryEnabled\natomic_groups:" in out
    assert out.endswith("atomic_groups:\n  1: Group\n")


def test_assign_ids_keeps_blank_line_and_removed_ids():
    text = "policies:\n  1: HomepageLocation\n  57: ''\n  1496: Last\n\natomic_groups:\n  1: Group\n"
    out = assign_ids(text, ["AgentEnabled"])
    assert out == "policies:\n  1: HomepageLocation\n  57: ''\n  1496: Last\n  1497: AgentEnabled\n\natomic_groups:\n  1: Group\n"


def test_assign_ids_is_idempotent():
    text = "policies:\n  1: HomepageLocation\n  1496: Last\natomic_groups:\n  1: Group\n"
    once = assign_ids(text, ["AgentEnabled", "MemoryEnabled"])
    assert assign_ids(once, ["AgentEnabled", "MemoryEnabled"]) == once
    assert assign_ids(once, ["MemoryEnabled", "SyncEnabled"]).count("MemoryEnabled") == 1
    assert "  1499: SyncEnabled\n" in assign_ids(once, ["MemoryEnabled", "SyncEnabled"])


def test_assign_ids_needs_a_policies_section():
    with pytest.raises(ValueError, match="policies:"):
        assign_ids("atomic_groups:\n  1: Group\n", ["AgentEnabled"])


def test_policy_ids_generator_writes_policies_yaml(tmp_path):
    target = tmp_path / POLICIES_YAML
    target.parent.mkdir(parents=True)
    target.write_text("policies:\n  1496: Last\n\natomic_groups:\n  1: Group\n")
    policy_ids_generator(CATALOGUE)(tmp_path)
    text = target.read_text()
    assert "  1497: AgentEnabled\n" in text and f"  {1496 + len(POLICIES)}: MinimumVersion\n" in text
    policy_ids_generator(CATALOGUE)(tmp_path)
    assert target.read_text() == text


def test_cli_registers_policy_ids_generator():
    assert "policy ids" in [name for name, _ in cli.GENERATORS]


def test_mobileconfig_is_stable_and_valid():
    policies = list(POLICIES.values())
    values = {"AgentEnabled": True, "MaxPermissionMode": "guard", "RemoteControlEnabled": False}
    data = mobileconfig(policies, values)
    assert data == mobileconfig(policies, values)
    profile = plistlib.loads(data)
    assert profile["PayloadType"] == "Configuration"
    payload = profile["PayloadContent"][0]
    assert payload["PayloadType"] == "co.xanom.perch"
    assert {k: payload[k] for k in values} == values
    assert profile["PayloadUUID"] != payload["PayloadUUID"]


def test_mobileconfig_refuses_bad_values():
    with pytest.raises(ValueError, match="MaxPermissionMode"):
        mobileconfig(list(POLICIES.values()), {"MaxPermissionMode": "loud"})
    with pytest.raises(ValueError, match="NotAPolicy"):
        mobileconfig(list(POLICIES.values()), {"NotAPolicy": True})


def test_policies_md_lists_every_policy():
    md = policies_md(list(POLICIES.values()))
    for name in POLICIES:
        assert f"| [`{name}`]" in md and f"## {name}\n" in md
    assert "| `\"skip\"` |" in md and "| unset |" in md


def test_generated_overlay_matches_catalogue():
    group = REPO / OVERLAY_GROUP
    since = read_catalogue(CATALOGUE)["since"]
    committed = {p.stem for p in group.glob("*.yaml") if not p.name.startswith(".")}
    assert committed == set(POLICIES)
    for p in POLICIES.values():
        assert (group / f"{p.name}.yaml").read_text() == template_yaml(p, since)
    assert (group / ".group.details.yaml").read_text() == group_details_yaml()


def test_committed_files_are_current():
    assert stale_files(REPO) == []


def test_owners_file_exists_for_the_templates():
    assert (REPO / "overlay/chrome/browser/perch/OWNERS").read_text().strip().endswith("github.com/neelsatyavolu/perch")


def _scratch_repo(tmp_path):
    (tmp_path / "enterprise").mkdir()
    (tmp_path / "enterprise/policies.json").write_text(CATALOGUE.read_text())
    return tmp_path


def test_generate_then_check(tmp_path):
    repo = _scratch_repo(tmp_path)
    assert len(stale_files(repo)) == len(POLICIES) + 3
    write_generated(repo)
    assert stale_files(repo) == []
    stray = repo / OVERLAY_GROUP / "OldPolicy.yaml"
    stray.write_text("caption: old\n")
    (repo / "docs/enterprise/policies.md").write_text("edited\n")
    assert stale_files(repo) == [Path("docs/enterprise/policies.md"), OVERLAY_GROUP / "OldPolicy.yaml"]
    write_generated(repo)
    assert stale_files(repo) == [] and not stray.exists()


def test_cli_policies_check_names_stale_files(tmp_path, monkeypatch, capsys):
    repo = _scratch_repo(tmp_path)
    monkeypatch.setattr(cli, "REPO", repo)
    assert cli.main(["policies", "check"]) == 1
    assert "docs/enterprise/policies.md" in capsys.readouterr().err
    assert cli.main(["policies", "generate"]) == 0
    assert cli.main(["policies", "check"]) == 0
