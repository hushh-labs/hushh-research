"""The assembled tool catalog is bound to the generated gateway and alias-free."""

from __future__ import annotations

import json
from pathlib import Path

from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import CircleRef, PersonRef, ToolPolicy
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS
from hushh_mcp.services.action_gateway import get_action_gateway_action

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_every_tool_binds_to_an_existing_gateway_action_with_a_compatible_policy():
    assert registry.validate_gateway_binding() == []
    assert len(registry.all_tools()) >= 40


def test_openable_screens_are_gateway_route_actions_only():
    for screen, action_id in OPENABLE_SCREENS.items():
        entry = get_action_gateway_action(action_id)
        assert entry is not None, (screen, action_id)
        path = str((entry.get("execution_target") or {}).get("path") or "")
        assert path in {"route", "kai_command"}, (screen, action_id, path)


def test_tool_names_are_unique_and_session_tools_are_reserved():
    names = [tool.name for tool in registry.all_tools()]
    assert len(names) == len(set(names))
    assert not set(names) & registry.SESSION_TOOL_NAMES
    declared = {item["name"] for item in registry.declarations()}
    assert registry.SESSION_TOOL_NAMES <= declared


def test_person_and_circle_arguments_are_canonical_ids_never_names():
    for tool in registry.all_tools():
        fields = tool.input_model.model_fields
        for arg in tool.person_args:
            assert fields[arg].annotation is PersonRef, (tool.name, arg)
        for arg in tool.circle_args:
            assert fields[arg].annotation is CircleRef, (tool.name, arg)
        # A mutation that names a person/circle must go through the typed ref.
        if tool.policy is not ToolPolicy.read:
            for name in fields:
                lowered = name.lower()
                if lowered in {"person_name", "circle_name", "spoken_name", "name_of_person"}:
                    raise AssertionError(f"{tool.name}.{name} accepts a free-text entity name")


def test_declarations_are_self_contained_json_schemas():
    for item in registry.declarations():
        schema = item["parameters_json_schema"]
        text = json.dumps(schema)
        assert "$ref" not in text and "$defs" not in text, item["name"]
        assert schema.get("type") == "object", item["name"]
        assert item["description"].strip(), item["name"]


def test_projection_has_no_aliases_and_is_current():
    projection = registry.projection()
    text = json.dumps(projection)
    assert '"aliases"' not in text
    assert projection["schema_version"] == "one.voice.live_tools.v1"
    rendered = registry.render_projection()
    for path in registry.projection_paths(REPO_ROOT):
        assert path.exists(), f"missing {path} (run scripts/generate_one_voice_tool_projection.py)"
        assert path.read_text(encoding="utf-8") == rendered, f"stale {path}"


def test_confirm_required_gateway_actions_are_never_direct_tools():
    for tool in registry.all_tools():
        entry = get_action_gateway_action(tool.gateway_action_id) or {}
        policy = str(((entry.get("risk") or {}).get("execution_policy")) or "")
        if policy == "confirm_required":
            assert tool.policy.needs_confirmation, tool.name


def test_destructive_tools_require_a_tap():
    tap_tools = {t.name for t in registry.all_tools() if t.policy is ToolPolicy.confirm_tap}
    for required in (
        "turn_sharing_off",
        "stop_share",
        "delete_circle",
        "remove_circle_member",
        "leave_circle",
        "revoke_public_link",
        "trigger_save_my_soul",
        "stop_save_my_soul",
        "remove_emergency_contact",
        "remove_connection",
        "update_display_name",
        "set_contact_discoverable",
        "accept_location_setup_consent",
    ):
        assert required in tap_tools, required
