"""Assembled tool catalog and its gateway binding.

The catalog is the union of the family modules' ``TOOLS`` tuples plus the
executor-owned session tools (confirm/cancel pending). Validation runs at
import time and again in tests: every tool binds to an existing gateway
action id, and a gateway ``confirm_required`` policy can never be weakened to
``direct``.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from hushh_mcp.one_voice.tools.base import ToolPolicy, ToolSpec

# Session tools are executed by the ToolExecutor itself; they still appear in
# the model's declarations so it can ask for a confirmation or a cancel.
SESSION_TOOL_DECLARATIONS: tuple[dict[str, Any], ...] = (
    {
        "name": "confirm_pending_action",
        "description": (
            "Confirm the one pending action after the person clearly said yes. "
            "Only valid once the confirmation card has been shown; actions that need a tap "
            "return tap_required and the person must tap Confirm on the card."
        ),
        "parameters_json_schema": {
            "type": "object",
            "properties": {"pending_action_id": {"type": "string"}},
            "required": ["pending_action_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "cancel_pending_action",
        "description": "Cancel the pending action when the person says no, stop, cancel, or changes their mind.",
        "parameters_json_schema": {
            "type": "object",
            "properties": {"pending_action_id": {"type": "string"}},
            "required": ["pending_action_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_pending_action",
        "description": "Read the current pending action, if any, before narrating what is waiting for confirmation.",
        "parameters_json_schema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
)
SESSION_TOOL_NAMES = frozenset(item["name"] for item in SESSION_TOOL_DECLARATIONS)


class ToolRegistryError(RuntimeError):
    pass


def _family_tools() -> tuple[ToolSpec, ...]:
    from hushh_mcp.one_voice.tools import (
        account_lifecycle,
        circles,
        location_state,
        onboarding,
        people,
        profile,
        session,
        sharing,
        sos,
    )

    tools: list[ToolSpec] = []
    for module in (
        session,
        people,
        location_state,
        sharing,
        circles,
        sos,
        profile,
        account_lifecycle,
        onboarding,
    ):
        tools.extend(module.TOOLS)
    return tuple(tools)


@lru_cache(maxsize=1)
def all_tools() -> tuple[ToolSpec, ...]:
    tools = _family_tools()
    names = [tool.name for tool in tools]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise ToolRegistryError(f"duplicate tool names: {duplicates}")
    clash = sorted(set(names) & SESSION_TOOL_NAMES)
    if clash:
        raise ToolRegistryError(f"tool names reserved for the executor: {clash}")
    return tools


@lru_cache(maxsize=1)
def _by_name() -> dict[str, ToolSpec]:
    return {tool.name: tool for tool in all_tools()}


def get_tool(name: str | None) -> ToolSpec | None:
    return _by_name().get(str(name or "").strip())


def declarations() -> list[dict[str, Any]]:
    """Function declarations for the Live session, session tools included."""
    return [tool.declaration() for tool in all_tools()] + list(SESSION_TOOL_DECLARATIONS)


def validate_gateway_binding() -> list[str]:
    """Return human-readable binding problems (empty when the catalog is sound)."""
    from hushh_mcp.services.action_gateway import get_action_gateway_action

    problems: list[str] = []
    for tool in all_tools():
        entry = get_action_gateway_action(tool.gateway_action_id)
        if entry is None:
            problems.append(
                f"{tool.name}: gateway action {tool.gateway_action_id!r} does not exist"
            )
            continue
        policy = str(((entry.get("risk") or {}).get("execution_policy")) or "")
        if policy == "confirm_required" and not tool.policy.needs_confirmation:
            problems.append(
                f"{tool.name}: gateway {tool.gateway_action_id!r} is confirm_required but the tool "
                f"policy is {tool.policy.value}"
            )
        if policy == "manual_only" and tool.policy is not ToolPolicy.read:
            problems.append(f"{tool.name}: gateway {tool.gateway_action_id!r} is manual_only")
    return problems


def projection() -> dict[str, Any]:
    """Derived catalog checked into ``contracts/kai`` so the frontend, docs, and
    CI see the same tool surface the model does. No aliases, by construction."""
    tools = []
    for tool in sorted(all_tools(), key=lambda item: item.name):
        tools.append(
            {
                "name": tool.name,
                "gateway_action_id": tool.gateway_action_id,
                "policy": tool.policy.value,
                "tier": tool.policy.tier,
                "description": tool.description,
                "person_args": list(tool.person_args),
                "circle_args": list(tool.circle_args),
                "ui_refresh": list(tool.ui_refresh),
                "firebase_plane": tool.firebase_plane,
                "parameters": tool.declaration()["parameters_json_schema"],
                "result_statuses": _result_statuses(tool),
            }
        )
    return {
        "schema_version": "one.voice.live_tools.v1",
        "session_tools": [item["name"] for item in SESSION_TOOL_DECLARATIONS],
        "tools": tools,
    }


def _result_statuses(tool: ToolSpec) -> list[str]:
    field = tool.output_model.model_fields.get("status")
    annotation = getattr(field, "annotation", None)
    args = getattr(annotation, "__args__", None)
    if args and all(isinstance(item, str) for item in args):
        return sorted(args)
    return []


def render_projection() -> str:
    return json.dumps(projection(), indent=2, sort_keys=True) + "\n"


def projection_paths(repo_root: Path) -> list[Path]:
    return [
        repo_root / "contracts" / "kai" / "one-voice-live-tools.v1.json",
        repo_root / "hushh-webapp" / "contracts" / "kai" / "one-voice-live-tools.v1.json",
        repo_root / "consent-protocol" / "contracts" / "kai" / "one-voice-live-tools.v1.json",
    ]
