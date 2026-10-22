"""The assembled tool catalog is bound to the generated gateway and alias-free."""

from __future__ import annotations

import json
from pathlib import Path
from typing import get_args, get_origin

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


def _is_entity_arg(annotation: object, ref: type) -> bool:
    """The argument is the typed ref, or a list of it and nothing else.

    Arity may vary -- a batch tool names several people in one argument -- but the
    point of the assertion does not: the id always arrives as the typed ref, never
    as a spoken name, and a list of something else is still a failure.
    """
    if annotation is ref:
        return True
    return get_origin(annotation) is list and get_args(annotation) == (ref,)


def test_person_and_circle_arguments_are_canonical_ids_never_names():
    for tool in registry.all_tools():
        fields = tool.input_model.model_fields
        for arg in tool.person_args:
            assert _is_entity_arg(fields[arg].annotation, PersonRef), (tool.name, arg)
        for arg in tool.circle_args:
            assert _is_entity_arg(fields[arg].annotation, CircleRef), (tool.name, arg)
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


# --- device Location updates tools: statuses, alias independence ------------


DEVICE_TOOL_NAMES = ("resume_device_location_updates", "pause_device_location_updates")
DEVICE_ACTION_IDS = ("location.resume_updates", "location.pause_updates")
ONE_VOICE_ROOT = Path(registry.__file__).resolve().parents[1]


def test_device_tools_project_their_full_status_vocabulary():
    by_name = {tool["name"]: tool for tool in registry.projection()["tools"]}
    for name in DEVICE_TOOL_NAMES:
        assert by_name[name]["result_statuses"] == sorted(
            ["location_updates_pending", "on", "off", "already_on", "already_off", "rejected"]
        )
        assert by_name[name]["policy"] == "direct"
        assert by_name[name]["parameters"] == {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        }


async def test_device_tools_bind_and_execute_without_gateway_aliases(monkeypatch):
    from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
    from hushh_mcp.one_voice.tools.executor import ToolExecutor
    from hushh_mcp.services import action_gateway

    real = action_gateway.get_action_gateway_action
    for action_id in DEVICE_ACTION_IDS:
        entry = real(action_id)
        assert entry and entry["aliases"] and entry["search_keywords"], action_id

    def _alias_free(action_id):
        entry = real(action_id)
        if entry is None:
            return None
        return {**entry, "aliases": [], "search_keywords": []}

    monkeypatch.setattr(action_gateway, "get_action_gateway_action", _alias_free)
    for action_id in DEVICE_ACTION_IDS:
        stripped = action_gateway.get_action_gateway_action(action_id)
        assert stripped["aliases"] == [] and stripped["search_keywords"] == []
        assert stripped["execution_target"]["path"] == "local_handler"

    assert registry.validate_gateway_binding() == []
    declared = {item["name"] for item in registry.declarations()}
    projected = {item["name"] for item in registry.projection()["tools"]}
    assert set(DEVICE_TOOL_NAMES) <= declared
    assert set(DEVICE_TOOL_NAMES) <= projected

    ctx = ToolContext(
        user_id="owner-1",
        conversation_id="c" * 36,
        entities=EntityContext(),
        screen=ScreenContext(screen_id="one_home", route="/one"),
        vault_owner_token="vault-token",  # noqa: S106 - test fixture, not a secret
    )
    outcome = await ToolExecutor().call(ctx, "resume_device_location_updates", {})
    assert outcome.spec is registry.get_tool("resume_device_location_updates")
    assert outcome.pending is None
    assert outcome.result.status == "location_updates_pending"
    assert outcome.result.needs == "client_step"
    assert outcome.result.client_step == {
        "kind": "set_location_updates",
        "desired_state": "on",
        "gateway_action_id": "location.resume_updates",
        "timeout_s": 45,
    }
    assert ctx.services == {}


async def test_executor_resolves_tools_only_by_exact_name():
    import inspect

    from hushh_mcp.one_voice.tools import executor as executor_module
    from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
    from hushh_mcp.one_voice.tools.executor import ToolExecutor

    source = inspect.getsource(executor_module.ToolExecutor._call)
    assert "registry.get_tool(name)" in source
    ctx = ToolContext(
        user_id="owner-1",
        conversation_id="c" * 36,
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test fixture, not a secret
    )
    for spoken in (
        "resume my location",
        "turn my location back on",
        "Resume_Device_Location_Updates",
        "location.resume_updates",
    ):
        outcome = await ToolExecutor().call(ctx, spoken, {})
        assert outcome.spec is None
        assert (outcome.result.status, outcome.result.reason_code) == ("rejected", "unknown_tool")


def test_one_voice_package_has_no_lexical_matcher_on_the_path():
    """Static proof: nothing under hushh_mcp/one_voice imports or calls the
    alias/synonym retrieval helpers. Comments and docstrings may mention the
    word; import lines, calls, identifiers, and gateway field keys may not."""
    import ast

    forbidden_modules = ("action_retrieval", "search_actions")
    forbidden_fragments = ("alias", "synonym", "search_actions", "action_retrieval")
    forbidden_keys = frozenset({"alias", "aliases", "synonyms", "search_keywords"})
    offences: list[str] = []
    for path in sorted(ONE_VOICE_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        rel = path.relative_to(ONE_VOICE_ROOT)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""] + [alias.name for alias in node.names]
            elif isinstance(node, ast.Call):
                func = node.func
                names = [func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")]
            elif isinstance(node, (ast.Name, ast.Attribute)):
                names = [node.id if isinstance(node, ast.Name) else node.attr]
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                # A gateway field read by key (entry["aliases"]) is a matcher too.
                names = [node.value] if node.value in forbidden_keys else []
            else:
                continue
            for name in names:
                lowered = name.lower()
                if any(module in lowered for module in forbidden_modules) or any(
                    fragment in lowered for fragment in forbidden_fragments
                ):
                    offences.append(f"{rel}:{node.lineno} {name}")
    assert offences == []


def test_voice_mail_is_exactly_read_open_access_and_a_reviewed_draft():
    """Mail on voice is eight tools, and drafts three more. Archive, label,
    read-state, trash, forward and draft deletion are mailbox mutations that
    need their own policy review; none may appear as a voice tool by accident.

    Reply was reviewed: its recipient, subject and thread are derived from the
    message it answers, never from the model, and only the owner's Send tap
    delivers it. It is the only reply tool.

    Scheduled send was reviewed: a spoken yes stores a sealed row that the
    server sends at the confirmed time, so it has no device step; the recipient
    is a confirmed connection and the words are sealed. Cancel names a position
    in the list the owner was shown. Drafts were reviewed: list and open read,
    send_draft sends a listed draft by position after a spoken yes, and there is
    no discard (it needs gmail.modify, an unreviewed grant)."""
    declared = {item["name"] for item in registry.declarations()}
    mail_tools = {name for name in declared if "mail" in name}
    assert mail_tools == {
        "compose_mail",
        "edit_mail_draft",
        "send_reviewed_mail",
        "get_mail_draft_status",
        "get_mail_access",
        "read_mail",
        "open_mail",
        "send_mail",
        "reply_mail",
        "schedule_mail",
        "list_scheduled_mail",
        "cancel_scheduled_mail",
    }
    assert {name for name in declared if "draft" in name} == {
        "edit_mail_draft",
        "get_mail_draft_status",
        "list_drafts",
        "open_draft",
        "send_draft",
    }
    for forbidden in ("archive", "label", "mark_read", "unread", "trash", "forward", "discard"):
        assert not [name for name in declared if forbidden in name], forbidden
    assert not [name for name in declared if "draft" in name and "delete" in name]
    schedule = registry.get_tool("schedule_mail")
    assert schedule is not None and schedule.policy.value == "confirm_voice"
    assert schedule.device_step is False, "the server sends it later; no device is present"
    assert schedule.person_args == ("recipient",)
    assert set(schedule.private_args) == {"subject", "message"}
    assert schedule.prepare is not None
    # A clock time is send_at; a duration is send_in_minutes, counted by the server.
    assert set(schedule.declaration()["parameters_json_schema"]["properties"]) == {
        "recipient",
        "subject",
        "message",
        "send_at",
        "send_in_minutes",
    }
    listed = registry.get_tool("list_scheduled_mail")
    assert listed is not None and listed.policy.value == "read"
    for name in ("cancel_scheduled_mail", "send_draft"):
        tool = registry.get_tool(name)
        assert tool is not None and tool.policy.value == "confirm_voice", name
        assert tool.person_args == () and tool.private_args == (), name
        assert set(tool.declaration()["parameters_json_schema"]["properties"]) == {"ordinal"}
        assert tool.lookup_targets == () and tool.target_key is not None, name
        assert tool.prepare is not None, name
    for name in ("list_drafts", "open_draft"):
        tool = registry.get_tool(name)
        assert tool is not None and tool.policy.value == "read", name
    assert [name for name in declared if "reply" in name] == ["reply_mail"]
    send = registry.get_tool("send_mail")
    assert send is not None and send.policy.value == "confirm_voice"
    assert send.device_step is True, "only a live session can open the review card"
    assert set(send.private_args) == {"subject", "message"}
    reply = registry.get_tool("reply_mail")
    assert reply is not None and reply.policy.value == "confirm_voice"
    assert reply.device_step is True, "only a live session can open the review card"
    assert reply.private_args == ("message",)
    # Addressed by the email it answers: the model can name a position and the
    # owner's words, and nothing a recipient, subject or thread could ride in.
    assert reply.person_args == () and reply.circle_args == ()
    parameters = reply.declaration()["parameters_json_schema"]
    assert set(parameters["properties"]) == {"ordinal", "message"}
    assert parameters["additionalProperties"] is False
    # A lookup made for something else never cancels the card the person is answering.
    assert reply.lookup_targets == ()
    # The same words about a different email are a different proposal, and the
    # card is prepared from a fresh read of the source before it is shown.
    assert reply.target_key is not None and reply.prepare is not None
